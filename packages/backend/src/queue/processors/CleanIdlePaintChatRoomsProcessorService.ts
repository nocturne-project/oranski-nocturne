/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 1時間以上アイドル状態のactiveルームを自動終了し、Redisキーをクリーンアップする
// 10分ごとにスケジュール実行される

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type {
	PaintChatRoomsRepository,
	PaintChatParticipantsRepository,
	PaintChatMessagesRepository,
} from '@/models/_.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { PaintChatCanvasService } from '@/core/PaintChatCanvasService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';

// アイドル判定の閾値（1時間）
const IDLE_THRESHOLD_MS = 1000 * 60 * 60;
// DB退避データの保持期間（7日間）
const CANVAS_ARCHIVE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

@Injectable()
export class CleanIdlePaintChatRoomsProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.paintChatRoomsRepository)
		private paintChatRoomsRepository: PaintChatRoomsRepository,

		@Inject(DI.paintChatParticipantsRepository)
		private paintChatParticipantsRepository: PaintChatParticipantsRepository,

		@Inject(DI.paintChatMessagesRepository)
		private paintChatMessagesRepository: PaintChatMessagesRepository,

		private paintChatCanvasService: PaintChatCanvasService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('clean-idle-paint-chat-rooms');
	}

	@bindThis
	public async process(job: Bull.Job<Record<string, unknown>>): Promise<{
		endedCount: number;
		deletedRedisKeys: number;
	}> {
		this.logger.info('Checking for idle paint chat rooms...');

		const cutoff = new Date(Date.now() - IDLE_THRESHOLD_MS);

		// activeルームのうち、作成から1時間以上経過したものを取得
		const candidateRooms = await this.paintChatRoomsRepository
			.createQueryBuilder('room')
			.where('room.status = :status', { status: 'active' })
			.andWhere('room.createdAt < :cutoff', { cutoff })
			.getMany();

		if (candidateRooms.length === 0) {
			this.logger.info('No idle paint chat rooms found.');
			return { endedCount: 0, deletedRedisKeys: 0 };
		}

		let endedCount = 0;
		let deletedRedisKeys = 0;
		let archivedCount = 0;

		for (const room of candidateRooms) {
			try {
				// 描画アクティビティ（Redis）を確認し、直近1時間以内にあればスキップ
				const redisLastActivity = await this.paintChatCanvasService.getLastActivity(room.id);
				if (redisLastActivity != null && redisLastActivity > cutoff.getTime()) continue;

				// チャットメッセージ（DB）を確認し、直近1時間以内にあればスキップ
				const latestMessage = await this.paintChatMessagesRepository
					.createQueryBuilder('msg')
					.where('msg.roomId = :roomId', { roomId: room.id })
					.orderBy('msg.createdAt', 'DESC')
					.getOne();

				// 最終アクティビティ = 最新メッセージの時刻、なければルーム作成時刻
				const lastActivity = latestMessage?.createdAt ?? room.createdAt;
				if (lastActivity > cutoff) continue;

				// RedisのキャンバスデータをDBに退避（削除前に保存）
				const saved = await this.paintChatCanvasService.saveCanvasToDb(room.id);
				if (saved) archivedCount++;

				// ルームを終了状態にする
				await this.paintChatRoomsRepository.update(room.id, {
					status: 'ended',
					endedAt: new Date(),
				});

				// 参加者IDを取得してRedisキーを一括削除
				const participants = await this.paintChatParticipantsRepository.findBy({ roomId: room.id });
				const participantIds = participants.map(p => p.id);
				const deleted = await this.paintChatCanvasService.cleanupRoom(room.id, participantIds);

				endedCount++;
				deletedRedisKeys += deleted;
			} catch (err) {
				this.logger.error(`Failed to process idle room ${room.id}: ${err}`);
			}
		}

		if (endedCount > 0) {
			this.logger.succ(`Ended ${endedCount} idle paint chat rooms, archived ${archivedCount} canvases to DB, deleted ${deletedRedisKeys} Redis keys.`);
		} else {
			this.logger.info('No idle paint chat rooms found.');
		}

		// DB退避キャンバスデータの7日間自動削除（通報ルームは除外）
		const archiveCutoff = new Date(Date.now() - CANVAS_ARCHIVE_TTL_MS);
		const expiredResult = await this.paintChatRoomsRepository
			.createQueryBuilder()
			.update()
			.set({ canvasStrokes: null, canvasMergedImage: null })
			.where('status = :status', { status: 'ended' })
			.andWhere('isReported = :isReported', { isReported: false })
			.andWhere('endedAt < :archiveCutoff', { archiveCutoff })
			.andWhere('"canvasStrokes" IS NOT NULL')
			.execute();

		if (expiredResult.affected != null && expiredResult.affected > 0) {
			this.logger.info(`Cleared ${expiredResult.affected} expired canvas archives from DB.`);
		}

		return { endedCount, deletedRedisKeys };
	}
}
