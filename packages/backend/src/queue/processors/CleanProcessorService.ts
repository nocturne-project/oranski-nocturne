/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, LessThan } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type {
	AntennasRepository,
	RoleAssignmentsRepository,
	UserIpsRepository,
	PaintChatRoomsRepository,
	PaintChatParticipantsRepository,
	PaintChatMessagesRepository,
	PaintChatPublishesRepository,
} from '@/models/_.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import type { Config } from '@/config.js';
import { ReversiService } from '@/core/ReversiService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';

// ランダム絵チャットのデータ保持期間（7日間: FR-017）
const PAINT_CHAT_RETENTION_MS = 1000 * 60 * 60 * 24 * 7;

@Injectable()
export class CleanProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.userIpsRepository)
		private userIpsRepository: UserIpsRepository,

		@Inject(DI.antennasRepository)
		private antennasRepository: AntennasRepository,

		@Inject(DI.roleAssignmentsRepository)
		private roleAssignmentsRepository: RoleAssignmentsRepository,

		@Inject(DI.paintChatRoomsRepository)
		private paintChatRoomsRepository: PaintChatRoomsRepository,

		@Inject(DI.paintChatParticipantsRepository)
		private paintChatParticipantsRepository: PaintChatParticipantsRepository,

		@Inject(DI.paintChatMessagesRepository)
		private paintChatMessagesRepository: PaintChatMessagesRepository,

		@Inject(DI.paintChatPublishesRepository)
		private paintChatPublishesRepository: PaintChatPublishesRepository,

		private queueLoggerService: QueueLoggerService,
		private reversiService: ReversiService,
		private idService: IdService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('clean');
	}

	@bindThis
	public async process(): Promise<void> {
		this.logger.info('Cleaning...');

		this.userIpsRepository.delete({
			createdAt: LessThan(new Date(Date.now() - (1000 * 60 * 60 * 24 * 90))),
		});

		// 使われてないアンテナを停止
		if (this.config.deactivateAntennaThreshold > 0) {
			this.antennasRepository.update({
				lastUsedAt: LessThan(new Date(Date.now() - this.config.deactivateAntennaThreshold)),
			}, {
				isActive: false,
			});
		}

		const expiredRoleAssignments = await this.roleAssignmentsRepository.createQueryBuilder('assign')
			.where('assign.expiresAt IS NOT NULL')
			.andWhere('assign.expiresAt < :now', { now: new Date() })
			.getMany();

		if (expiredRoleAssignments.length > 0) {
			await this.roleAssignmentsRepository.delete({
				id: In(expiredRoleAssignments.map(x => x.id)),
			});
		}

		this.reversiService.cleanOutdatedGames();

		// ランダム絵チャットの期限切れデータ削除（FR-017: セッション終了後7日間保持、通報ルームは除外）
		await this.cleanExpiredPaintChatData();

		this.logger.succ('Cleaned.');
	}

	// セッション終了後7日経過したランダム絵チャットのDBレコードを削除する
	@bindThis
	private async cleanExpiredPaintChatData(): Promise<void> {
		const cutoff = new Date(Date.now() - PAINT_CHAT_RETENTION_MS);

		// 削除対象: 終了済み + 7日経過 + 通報されていないルーム
		const expiredRooms = await this.paintChatRoomsRepository.createQueryBuilder('room')
			.where('room.status = :status', { status: 'ended' })
			.andWhere('room.endedAt < :cutoff', { cutoff })
			.andWhere('room.isReported = :isReported', { isReported: false })
			.getMany();

		if (expiredRooms.length === 0) return;

		const roomIds = expiredRooms.map(r => r.id);
		this.logger.info(`Cleaning ${roomIds.length} expired paint chat rooms...`);

		// 依存テーブルを先に削除
		await this.paintChatPublishesRepository.delete({ roomId: In(roomIds) });
		await this.paintChatMessagesRepository.delete({ roomId: In(roomIds) });
		await this.paintChatParticipantsRepository.delete({ roomId: In(roomIds) });
		await this.paintChatRoomsRepository.delete({ id: In(roomIds) });

		this.logger.info(`Cleaned ${roomIds.length} expired paint chat rooms.`);
	}
}
