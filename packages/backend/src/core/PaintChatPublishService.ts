/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type {
	PaintChatPublishesRepository,
	PaintChatSettingsRepository,
	PaintChatRoomsRepository,
	UsersRepository,
} from '@/models/_.js';
import type { PaintChatParticipant } from '@/models/PaintChatParticipant.js';
import { IdService } from '@/core/IdService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { DriveService } from '@/core/DriveService.js';
import { bindThis } from '@/decorators.js';

// ステガノグラフィ: LSB方式でルームIDをPNG画像に埋め込む
const STEGO_MAGIC = 'PC';

function embedSteganography(pixelData: Buffer, roomId: string): void {
	const payload = STEGO_MAGIC + String.fromCharCode(roomId.length) + roomId;
	const bits: number[] = [];
	for (let i = 0; i < payload.length; i++) {
		const charCode = payload.charCodeAt(i);
		for (let bit = 7; bit >= 0; bit--) {
			bits.push((charCode >> bit) & 1);
		}
	}
	// RGBチャネルのLSBにビットを埋め込む（Aチャネルはスキップ）
	let bitIndex = 0;
	for (let i = 0; i < pixelData.length && bitIndex < bits.length; i++) {
		if (i % 4 === 3) continue; // Aチャネルスキップ
		pixelData[i] = (pixelData[i] & 0xFE) | bits[bitIndex];
		bitIndex++;
	}
}

async function embedSteganographyToBuffer(imageBuffer: Buffer, roomId: string): Promise<Buffer> {
	const image = sharp(imageBuffer);
	const metadata = await image.metadata();
	const { data, info } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });

	embedSteganography(data, roomId);

	return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
		.png()
		.toBuffer();
}

// 品質ガードの閾値設定（緩めに設定。実際のお絵かきで引っかからないようにする）
const MIN_SESSION_DURATION_MS = 1 * 60 * 1000; // セッション開始1分以上経過
const MIN_STROKE_POINTS = 10; // 合計ポイント数10以上

// bot投稿、ステガノグラフィ埋め込み、品質ガードを担当するサービス
@Injectable()
export class PaintChatPublishService {
	constructor(
		@Inject(DI.paintChatPublishesRepository)
		private paintChatPublishesRepository: PaintChatPublishesRepository,

		@Inject(DI.paintChatSettingsRepository)
		private paintChatSettingsRepository: PaintChatSettingsRepository,

		@Inject(DI.paintChatRoomsRepository)
		private paintChatRoomsRepository: PaintChatRoomsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
		private noteCreateService: NoteCreateService,
		private driveService: DriveService,
	) {
	}

	// botアカウントでキャンバス画像をノート投稿する
	@bindThis
	public async publishToTimeline(
		roomId: string,
		imageBuffer: Buffer,
		participant1Name: string,
		participant2Name: string,
		message1: string | null,
		message2: string | null,
	): Promise<string | null> {
		const setting = await this.paintChatSettingsRepository.findOne({ where: {} });
		if (setting == null || setting.botAccountId == null) return null;

		const botUser = await this.usersRepository.findOneBy({ id: setting.botAccountId });
		if (botUser == null) return null;

		// ステガノグラフィでルームIDを埋め込んでから一時ファイルに書き出し
		const stegoBuffer = await embedSteganographyToBuffer(imageBuffer, roomId);
		const tmpDir = os.tmpdir();
		const tmpPath = path.join(tmpDir, `paintchat-${roomId}-${Date.now()}.png`);
		fs.writeFileSync(tmpPath, stegoBuffer);

		let driveFile;
		try {
			driveFile = await this.driveService.addFile({
				user: botUser,
				path: tmpPath,
				name: `paintchat-${roomId}.png`,
				comment: null,
				folderId: null,
				force: true,
				isLink: false,
				url: null,
				uri: null,
				sensitive: false,
				requestIp: null,
				requestHeaders: null,
			});
		} finally {
			// 一時ファイルを削除
			try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		}

		// ノート本文を構成（匿名名を含めて誰の合作か表示）
		const lines: string[] = [`ランダム絵チャットの作品（${participant1Name}と${participant2Name}の絵）`];
		if (message1) lines.push(`${participant1Name}: ${message1}`);
		if (message2) lines.push(`${participant2Name}: ${message2}`);
		const text = lines.join('\n');

		// botアカウントでノート投稿（作品投稿は連合許可）
		const note = await this.noteCreateService.create(botUser, {
			text,
			files: [driveFile],
			localOnly: false,
			visibility: 'public',
		});

		// publishレコードを更新
		await this.paintChatPublishesRepository.update({ roomId }, {
			publishedAt: new Date(),
			noteId: note.id,
		});

		// ルームのisPublishedフラグを更新
		await this.paintChatRoomsRepository.update(roomId, {
			isPublished: true,
		});

		return note.id;
	}

	// 自分の絵のみをbot経由で匿名投稿する（相手の同意不要）
	// ルームID・投稿者participantId・ノートIDをDBに記録して追跡可能にする
	@bindThis
	public async publishMyArt(
		roomId: string,
		imageBuffer: Buffer,
		anonymousName: string,
		participantId: string,
	): Promise<string | null> {
		const setting = await this.paintChatSettingsRepository.findOne({ where: {} });
		if (setting == null || setting.botAccountId == null) return null;

		const botUser = await this.usersRepository.findOneBy({ id: setting.botAccountId });
		if (botUser == null) return null;

		// ステガノグラフィでルームIDを埋め込んでから一時ファイルに書き出し
		const stegoBuffer = await embedSteganographyToBuffer(imageBuffer, roomId);
		const tmpDir = os.tmpdir();
		const tmpPath = path.join(tmpDir, `paintchat-myart-${roomId}-${Date.now()}.png`);
		fs.writeFileSync(tmpPath, stegoBuffer);

		let driveFile;
		try {
			driveFile = await this.driveService.addFile({
				user: botUser,
				path: tmpPath,
				name: `paintchat-myart-${roomId}.png`,
				comment: null,
				folderId: null,
				force: true,
				isLink: false,
				url: null,
				uri: null,
				sensitive: false,
				requestIp: null,
				requestHeaders: null,
			});
		} finally {
			try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		}

		const text = `ランダム絵チャットの作品（${anonymousName}の絵）`;

		// 自分の絵のみ投稿も連合許可
		const note = await this.noteCreateService.create(botUser, {
			text,
			files: [driveFile],
			localOnly: false,
			visibility: 'public',
		});

		// DB記録: ルームID・投稿者・ノートIDを追跡可能にする
		// paint_chat_publishテーブルにmy-art用レコードを作成（participant1=投稿者、participant2=投稿者）
		const existing = await this.paintChatPublishesRepository.findOneBy({ roomId });
		if (existing == null) {
			await this.paintChatPublishesRepository.insert({
				id: this.idService.gen(),
				roomId,
				participant1Id: participantId,
				participant1Agreed: true,
				participant2Id: participantId,
				participant2Agreed: true,
				publishedAt: new Date(),
				noteId: note.id,
			});
		} else {
			// 合作投稿レコードが既にある場合はnoteIdを更新（my-art投稿分）
			// 合作投稿のnoteIdは上書きしない。ログとして残す。
		}

		return note.id;
	}

	// 品質ガード: セッション時間、ストローク数、ポイント数をチェック
	@bindThis
	public async checkQualityGuard(roomId: string, strokeCount: number, totalPoints: number): Promise<{
		passed: boolean;
		reason?: string;
	}> {
		// (1) セッション開始からの経過時間チェック
		const room = await this.paintChatRoomsRepository.findOneBy({ id: roomId });
		if (room != null) {
			const elapsed = Date.now() - room.createdAt.getTime();
			if (elapsed < MIN_SESSION_DURATION_MS) {
				return { passed: false, reason: 'session_too_short' };
			}
		}

		// (2) キャンバスが真っ白（ストロークゼロ）
		if (strokeCount === 0) {
			return { passed: false, reason: 'canvas_empty' };
		}

		// (3) 描き込み量が閾値未満
		if (totalPoints < MIN_STROKE_POINTS) {
			return { passed: false, reason: 'not_enough_drawing' };
		}

		return { passed: true };
	}

	// 投稿同意レコードを作成する（最初の同意者が作成）
	@bindThis
	public async createPublishRequest(
		roomId: string,
		participant1: PaintChatParticipant,
		participant2: PaintChatParticipant,
		requesterId: string,
	): Promise<void> {
		const existing = await this.paintChatPublishesRepository.findOneBy({ roomId });
		if (existing != null) {
			// 既存レコードがある場合は同意状態を更新
			if (existing.participant1Id === requesterId) {
				await this.paintChatPublishesRepository.update(existing.id, {
					participant1Agreed: true,
				});
			} else if (existing.participant2Id === requesterId) {
				await this.paintChatPublishesRepository.update(existing.id, {
					participant2Agreed: true,
				});
			}
			return;
		}

		// 新規レコード作成
		const isRequesterP1 = requesterId === participant1.id;
		await this.paintChatPublishesRepository.insert({
			id: this.idService.gen(),
			roomId,
			participant1Id: participant1.id,
			participant1Agreed: isRequesterP1,
			participant2Id: participant2.id,
			participant2Agreed: !isRequesterP1,
		});
	}

	// 投稿同意状態を取得する
	@bindThis
	public async getPublishStatus(roomId: string): Promise<{
		exists: boolean;
		bothAgreed: boolean;
		published: boolean;
		participant1Agreed: boolean;
		participant2Agreed: boolean;
	}> {
		const record = await this.paintChatPublishesRepository.findOneBy({ roomId });
		if (record == null) {
			return { exists: false, bothAgreed: false, published: false, participant1Agreed: false, participant2Agreed: false };
		}
		return {
			exists: true,
			bothAgreed: record.participant1Agreed && record.participant2Agreed,
			published: record.publishedAt != null,
			participant1Agreed: record.participant1Agreed,
			participant2Agreed: record.participant2Agreed,
		};
	}

	// 投稿を拒否する（同意レコードを削除）
	@bindThis
	public async rejectPublish(roomId: string): Promise<void> {
		await this.paintChatPublishesRepository.delete({ roomId });
	}

	// 一言メッセージを設定する
	@bindThis
	public async setMessage(roomId: string, participantId: string, message: string): Promise<void> {
		const record = await this.paintChatPublishesRepository.findOneBy({ roomId });
		if (record == null) return;

		if (record.participant1Id === participantId) {
			await this.paintChatPublishesRepository.update(record.id, {
				participant1Message: message,
			});
		} else if (record.participant2Id === participantId) {
			await this.paintChatPublishesRepository.update(record.id, {
				participant2Message: message,
			});
		}
	}

	// botアカウントが設定されているか確認する
	@bindThis
	public async isBotConfigured(): Promise<boolean> {
		const setting = await this.paintChatSettingsRepository.findOne({ where: {} });
		return setting != null && setting.botAccountId != null;
	}

	// 投稿済みかチェック
	@bindThis
	public async isPublished(roomId: string): Promise<boolean> {
		const record = await this.paintChatPublishesRepository.findOneBy({ roomId });
		return record != null && record.publishedAt != null;
	}

	// 投稿同意レコードを取得する
	@bindThis
	public async getPublishRecord(roomId: string) {
		return await this.paintChatPublishesRepository.findOneBy({ roomId });
	}
}
