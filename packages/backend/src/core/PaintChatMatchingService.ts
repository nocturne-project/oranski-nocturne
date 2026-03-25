/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiUser } from '@/models/User.js';
import type { UsersRepository, NotesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { bindThis } from '@/decorators.js';

const QUEUE_KEY = 'paintChat:queue';
const WAITING_PREFIX = 'paintChat:waiting:';
const RECRUITMENT_NOTE_PREFIX = 'paintChat:recruitmentNote:';

// マッチングキュー（Redis）管理、bot呼びかけを担当するサービス
@Injectable()
export class PaintChatMatchingService {
	// bot募集タイマー管理（leaveQueue時にキャンセルするため）
	private recruitmentTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private paintChatService: PaintChatService,
		private noteCreateService: NoteCreateService,
		private noteDeleteService: NoteDeleteService,
	) {
	}

	// マッチング待機キューに参加する（SET NXでアトミックに重複チェック）
	@bindThis
	public async joinQueue(userId: MiUser['id']): Promise<void> {
		// SET NXで既存エントリがなければ登録（アトミック、TOCTOU問題を回避）
		const result = await this.redisClient.set(
			`${WAITING_PREFIX}${userId}`,
			JSON.stringify({ joinedAt: Date.now() }),
			'EX', 600, // 10分で自動期限切れ
			'NX',
		);
		if (!result) {
			throw new Error('alreadyWaiting');
		}

		// キューに追加
		await this.redisClient.rpush(QUEUE_KEY, userId);

		// 1分後にbot呼びかけ投稿をスケジュール（FR-047）
		// タイマーをMapで管理し、leaveQueue時にキャンセル可能にする
		this.cancelRecruitmentTimer(userId);
		const timer = setTimeout(() => {
			this.recruitmentTimers.delete(userId);
			this.tryPostRecruitment(userId).catch((err) => {
				console.warn(`[PaintChat] bot recruitment posting failed for user ${userId}:`, err);
			});
		}, 60000);
		this.recruitmentTimers.set(userId, timer);
	}

	// bot呼びかけ投稿を実行する（1分経過時に自動呼び出し）
	@bindThis
	private async tryPostRecruitment(userId: MiUser['id']): Promise<void> {
		const shouldPost = await this.shouldPostRecruitment(userId);
		if (!shouldPost) return;

		// bot設定を取得
		const settings = await this.paintChatService.getSettings();
		if (settings.botAccountId == null) return;

		const botUser = await this.usersRepository.findOneBy({ id: settings.botAccountId });
		if (botUser == null) return;

		// 呼びかけ投稿
		const baseUrl = this.config.url.endsWith('/') ? this.config.url : this.config.url + '/';
		const paintChatUrl = `${baseUrl}paintchat`;
		const note = await this.noteCreateService.create(botUser, {
			text: `ランダム絵チャットで一緒にお絵かきしませんか？\n[ここから参加できます](${paintChatUrl})`,
			localOnly: true,
			visibility: 'public',
		});

		// 募集ノートIDを保存（マッチング成立時に削除するため）
		await this.redisClient.set(`${RECRUITMENT_NOTE_PREFIX}${userId}`, note.id, 'EX', 600);

		await this.markRecruitmentPosted(userId);
	}

	// マッチング待機キューから離脱する（タイマー・募集ノート・フラグも一括クリーンアップ）
	@bindThis
	public async leaveQueue(userId: MiUser['id']): Promise<void> {
		this.cancelRecruitmentTimer(userId);
		await this.redisClient.del(`${WAITING_PREFIX}${userId}`);
		await this.redisClient.lrem(QUEUE_KEY, 0, userId);
		await this.redisClient.del(`paintChat:recruitment:${userId}`);
		await this.deleteRecruitmentNote(userId).catch(() => {});
	}

	// 募集タイマーをキャンセルする
	private cancelRecruitmentTimer(userId: string): void {
		const timer = this.recruitmentTimers.get(userId);
		if (timer != null) {
			clearTimeout(timer);
			this.recruitmentTimers.delete(userId);
		}
	}

	// 既に待機中かチェック
	@bindThis
	public async isWaiting(userId: MiUser['id']): Promise<boolean> {
		return (await this.redisClient.exists(`${WAITING_PREFIX}${userId}`)) === 1;
	}

	// マッチングを試行する（ペアリング可能な相手を探す）。排他ロック付き。
	@bindThis
	public async tryMatch(userId: MiUser['id']): Promise<MiUser['id'] | null> {
		// マッチング処理全体にRedisロックをかけてレースコンディションを防止
		const lockKey = 'paintChat:matchLock';
		const lockAcquired = await this.redisClient.set(lockKey, userId, 'EX', 5, 'NX');
		if (!lockAcquired) return null; // 他のマッチング処理中

		try {
			const queueLength = await this.redisClient.llen(QUEUE_KEY);

			for (let i = 0; i < queueLength; i++) {
				const candidateId = await this.redisClient.lindex(QUEUE_KEY, i);
				if (candidateId == null) continue;
				if (candidateId === userId) continue;

				// 待機中かチェック（期限切れの場合はスキップ）
				const isStillWaiting = await this.redisClient.exists(`${WAITING_PREFIX}${candidateId}`);
				if (!isStillWaiting) {
					await this.redisClient.lrem(QUEUE_KEY, 1, candidateId);
					continue;
				}

				// 再マッチング除外チェック
				const isBlocked = await this.paintChatService.isBlocked(userId, candidateId);
				if (isBlocked) continue;

				// マッチ成立: 両者をキューから削除（パイプラインでアトミック化）
				const pipeline = this.redisClient.pipeline();
				pipeline.lrem(QUEUE_KEY, 1, candidateId);
				pipeline.lrem(QUEUE_KEY, 1, userId);
				pipeline.del(`${WAITING_PREFIX}${candidateId}`);
				pipeline.del(`${WAITING_PREFIX}${userId}`);
				await pipeline.exec();

				return candidateId;
			}

			return null;
		} finally {
			// ロック解放
			await this.redisClient.del(lockKey);
		}
	}

	// キュー内の待機人数を取得する
	@bindThis
	public async getQueueLength(): Promise<number> {
		return await this.redisClient.llen(QUEUE_KEY);
	}

	// bot呼びかけ投稿が必要か判定する（1分経過かつ未投稿のユーザーがいるか）
	@bindThis
	public async shouldPostRecruitment(userId: MiUser['id']): Promise<boolean> {
		const waitingData = await this.redisClient.get(`${WAITING_PREFIX}${userId}`);
		if (waitingData == null) return false;

		let parsed: { joinedAt: number };
		try {
			parsed = JSON.parse(waitingData);
		} catch {
			return false;
		}
		const elapsed = Date.now() - parsed.joinedAt;

		// 1分（60秒）経過チェック
		if (elapsed < 60000) return false;

		// 既に呼びかけ済みかチェック
		const recruitmentKey = `paintChat:recruitment:${userId}`;
		const already = await this.redisClient.exists(recruitmentKey);
		if (already) return false;

		return true;
	}

	// bot呼びかけ投稿済みフラグを立てる（1セッション1回制限）
	@bindThis
	public async markRecruitmentPosted(userId: MiUser['id']): Promise<void> {
		const recruitmentKey = `paintChat:recruitment:${userId}`;
		await this.redisClient.set(recruitmentKey, '1', 'EX', 600); // 10分で期限切れ
	}

	// マッチング成立時にbot募集ノートを削除する
	// 募集した人のマッチング成立をトリガーとしてノートを削除する
	@bindThis
	public async deleteRecruitmentNote(userId: MiUser['id']): Promise<void> {
		const noteId = await this.redisClient.get(`${RECRUITMENT_NOTE_PREFIX}${userId}`);
		if (noteId == null) return;

		// Redisから削除（二重削除防止）
		await this.redisClient.del(`${RECRUITMENT_NOTE_PREFIX}${userId}`);

		const note = await this.notesRepository.findOneBy({ id: noteId });
		if (note == null) return;

		// bot設定からbotユーザーを取得して削除実行
		const settings = await this.paintChatService.getSettings();
		if (settings.botAccountId == null) return;

		const botUser = await this.usersRepository.findOneBy({ id: settings.botAccountId });
		if (botUser == null) return;

		await this.noteDeleteService.delete(botUser, note, true);
	}
}
