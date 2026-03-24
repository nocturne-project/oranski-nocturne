/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type {
	PaintChatRoomsRepository,
	PaintChatParticipantsRepository,
	PaintChatBlocksRepository,
	PaintChatReportsRepository,
	PaintChatSettingsRepository,
} from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import type { PaintChatRoom } from '@/models/PaintChatRoom.js';
import type { PaintChatParticipant } from '@/models/PaintChatParticipant.js';
import { IdService } from '@/core/IdService.js';
import { bindThis } from '@/decorators.js';

// 匿名名に使う色（10種）
const COLORS = [
	'あかい', 'あおい', 'きいろい', 'みどりの', 'むらさきの',
	'オレンジの', 'ピンクの', 'しろい', 'くろい', 'みずいろの',
];

// 匿名名に使う動物名（30種）
const ANIMALS = [
	'ペンギン', 'ねこ', 'いぬ', 'うさぎ', 'くま',
	'パンダ', 'きつね', 'たぬき', 'ハムスター', 'リス',
	'コアラ', 'ひよこ', 'あひる', 'フクロウ', 'インコ',
	'イルカ', 'クジラ', 'カメ', 'カエル', 'ヤモリ',
	'ハリネズミ', 'アルパカ', 'ヒツジ', 'ウシ', 'ブタ',
	'ゾウ', 'キリン', 'ライオン', 'トラ', 'オオカミ',
];

// ランダム絵チャットのルーム管理、匿名名生成、ラッパーユーザーID管理を担当するサービス
@Injectable()
export class PaintChatService {
	constructor(
		@Inject(DI.paintChatRoomsRepository)
		private paintChatRoomsRepository: PaintChatRoomsRepository,

		@Inject(DI.paintChatParticipantsRepository)
		private paintChatParticipantsRepository: PaintChatParticipantsRepository,

		@Inject(DI.paintChatBlocksRepository)
		private paintChatBlocksRepository: PaintChatBlocksRepository,

		@Inject(DI.paintChatReportsRepository)
		private paintChatReportsRepository: PaintChatReportsRepository,

		@Inject(DI.paintChatSettingsRepository)
		private paintChatSettingsRepository: PaintChatSettingsRepository,

		private idService: IdService,
	) {
	}

	// ランダムな匿名名を生成する。excludeNamesに含まれる名前は除外する。
	@bindThis
	public generateAnonymousName(excludeNames: string[] = []): string {
		let name: string;
		let attempts = 0;
		do {
			const color = COLORS[Math.floor(Math.random() * COLORS.length)];
			const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
			name = `${color}${animal}`;
			attempts++;
			// 全300通りを使い切った場合は除外を諦める（安全弁）
			if (attempts > 300) break;
		} while (excludeNames.includes(name));
		return name;
	}

	// ユーザーの直近の匿名名を取得する（「毎回異なる」保証用: FR-005）
	@bindThis
	public async getRecentAnonymousNames(userId: MiUser['id'], limit = 3): Promise<string[]> {
		const recent = await this.paintChatParticipantsRepository.find({
			where: { userId },
			order: { joinedAt: 'DESC' },
			take: limit,
		});
		return recent.map(p => p.anonymousName);
	}

	// ルームを作成し、二人の参加者を登録する
	@bindThis
	public async createRoom(userIdA: MiUser['id'], userIdB: MiUser['id']): Promise<{
		room: PaintChatRoom;
		participantA: PaintChatParticipant;
		participantB: PaintChatParticipant;
	}> {
		const roomId = this.idService.gen();

		// ルーム作成
		await this.paintChatRoomsRepository.insert({
			id: roomId,
			status: 'active',
		});

		// 匿名名生成（前回のマッチングと被らないように + 同室内重複防止: FR-005）
		const recentNamesA = await this.getRecentAnonymousNames(userIdA);
		const recentNamesB = await this.getRecentAnonymousNames(userIdB);
		const nameA = this.generateAnonymousName(recentNamesA);
		const nameB = this.generateAnonymousName([...recentNamesB, nameA]);

		// 参加者登録（ラッパーユーザーID = PaintChatParticipant.id）
		const participantAId = this.idService.gen();
		const participantBId = this.idService.gen();

		await this.paintChatParticipantsRepository.insert({
			id: participantAId,
			roomId,
			userId: userIdA,
			anonymousName: nameA,
		});

		await this.paintChatParticipantsRepository.insert({
			id: participantBId,
			roomId,
			userId: userIdB,
			anonymousName: nameB,
		});

		const room = await this.paintChatRoomsRepository.findOneByOrFail({ id: roomId });
		const participantA = await this.paintChatParticipantsRepository.findOneByOrFail({ id: participantAId });
		const participantB = await this.paintChatParticipantsRepository.findOneByOrFail({ id: participantBId });

		return { room, participantA, participantB };
	}

	// ユーザーIDからルーム内のラッパーユーザーIDを解決する
	@bindThis
	public async resolveParticipant(roomId: string, userId: MiUser['id']): Promise<PaintChatParticipant | null> {
		return await this.paintChatParticipantsRepository.findOneBy({
			roomId,
			userId,
		});
	}

	// ラッパーユーザーIDからルーム内の参加者を取得する
	@bindThis
	public async getParticipantById(participantId: string): Promise<PaintChatParticipant | null> {
		return await this.paintChatParticipantsRepository.findOneBy({
			id: participantId,
		});
	}

	// ルームIDから全参加者を取得する
	@bindThis
	public async getRoomParticipants(roomId: string): Promise<PaintChatParticipant[]> {
		return await this.paintChatParticipantsRepository.findBy({ roomId });
	}

	// ルームにアクセスできるか確認する（ペアリングされた二人のみ）
	@bindThis
	public async canAccessRoom(roomId: string, userId: MiUser['id']): Promise<boolean> {
		const participant = await this.paintChatParticipantsRepository.findOneBy({
			roomId,
			userId,
		});
		return participant != null;
	}

	// 二人が再マッチング除外リストに含まれるかチェックする
	@bindThis
	public async isBlocked(userIdA: MiUser['id'], userIdB: MiUser['id']): Promise<boolean> {
		const block = await this.paintChatBlocksRepository.findOneBy([
			{ reporterUserId: userIdA, targetUserId: userIdB },
			{ reporterUserId: userIdB, targetUserId: userIdA },
		]);
		return block != null;
	}

	// ルームを終了する
	@bindThis
	public async endRoom(roomId: string): Promise<void> {
		await this.paintChatRoomsRepository.update(roomId, {
			status: 'ended',
			endedAt: new Date(),
		});
	}

	// 通報処理
	@bindThis
	public async reportRoom(
		roomId: string,
		reporterParticipantId: string,
		reporterUserId: MiUser['id'],
		targetUserId: MiUser['id'],
		reason?: string,
	): Promise<void> {
		// 通報レコード作成
		await this.paintChatReportsRepository.insert({
			id: this.idService.gen(),
			roomId,
			reporterParticipantId,
			reporterUserId,
			targetUserId,
			reason: reason ?? null,
			status: 'pending',
		});

		// 再マッチング除外リストに追加
		await this.paintChatBlocksRepository.insert({
			id: this.idService.gen(),
			reporterUserId,
			targetUserId,
		}).catch((e: any) => {
			// PostgreSQLのUNIQUE制約違反コード(23505)のみ無視、それ以外は再throw
			if (e.code === '23505') return;
			throw e;
		});

		// ルームに通報フラグを立てる
		await this.paintChatRoomsRepository.update(roomId, {
			isReported: true,
		});
	}

	// 現在の季節を判定する（春:3-5月, 夏:6-8月, 秋:9-11月, 冬:12-2月）
	@bindThis
	public getCurrentSeason(): 'spring' | 'summer' | 'autumn' | 'winter' {
		const month = new Date().getMonth() + 1; // 1-12
		if (month >= 3 && month <= 5) return 'spring';
		if (month >= 6 && month <= 8) return 'summer';
		if (month >= 9 && month <= 11) return 'autumn';
		return 'winter';
	}

	// admin設定を取得する（なければデフォルト値で作成）
	@bindThis
	public async getSettings(): Promise<{
		botAccountId: string | null;
		topicList: string;
		topicListSpring: string;
		topicListSummer: string;
		topicListAutumn: string;
		topicListWinter: string;
		noticeText: string;
	}> {
		let setting = await this.paintChatSettingsRepository.findOne({ where: {} });
		if (setting == null) {
			const settingId = this.idService.gen();
			await this.paintChatSettingsRepository.insert({
				id: settingId,
				botAccountId: null,
				topicList: '',
				topicListSpring: '',
				topicListSummer: '',
				topicListAutumn: '',
				topicListWinter: '',
				noticeText: '',
			});
			setting = await this.paintChatSettingsRepository.findOneByOrFail({ id: settingId });
		}
		return {
			botAccountId: setting.botAccountId,
			topicList: setting.topicList,
			topicListSpring: setting.topicListSpring,
			topicListSummer: setting.topicListSummer,
			topicListAutumn: setting.topicListAutumn,
			topicListWinter: setting.topicListWinter,
			noticeText: setting.noticeText,
		};
	}

	// 現在の季節のお題リストを取得する（汎用 + 季節別を結合）
	@bindThis
	public async getCurrentTopicList(): Promise<string> {
		const settings = await this.getSettings();
		const season = this.getCurrentSeason();
		let seasonalList = '';
		switch (season) {
			case 'spring': seasonalList = settings.topicListSpring; break;
			case 'summer': seasonalList = settings.topicListSummer; break;
			case 'autumn': seasonalList = settings.topicListAutumn; break;
			case 'winter': seasonalList = settings.topicListWinter; break;
		}
		// 汎用リスト + 季節別リストを結合
		const combined = [settings.topicList, seasonalList].filter(s => s.trim()).join('\n');
		return combined;
	}
}
