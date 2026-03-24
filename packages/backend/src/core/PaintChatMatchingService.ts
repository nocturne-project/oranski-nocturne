/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiUser } from '@/models/User.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { bindThis } from '@/decorators.js';

const QUEUE_KEY = 'paintChat:queue';
const WAITING_PREFIX = 'paintChat:waiting:';

// マッチングキュー（Redis）管理、bot呼びかけを担当するサービス
@Injectable()
export class PaintChatMatchingService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private paintChatService: PaintChatService,
	) {
	}

	// マッチング待機キューに参加する
	@bindThis
	public async joinQueue(userId: MiUser['id']): Promise<void> {
		// 既に待機中かチェック
		const existing = await this.redisClient.exists(`${WAITING_PREFIX}${userId}`);
		if (existing) {
			throw new Error('alreadyWaiting');
		}

		// 待機情報を登録
		await this.redisClient.set(`${WAITING_PREFIX}${userId}`, JSON.stringify({
			joinedAt: Date.now(),
		}), 'EX', 600); // 10分で自動期限切れ

		// キューに追加
		await this.redisClient.rpush(QUEUE_KEY, userId);
	}

	// マッチング待機キューから離脱する
	@bindThis
	public async leaveQueue(userId: MiUser['id']): Promise<void> {
		await this.redisClient.del(`${WAITING_PREFIX}${userId}`);
		await this.redisClient.lrem(QUEUE_KEY, 0, userId);
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
}
