/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type {
	PaintChatPublishesRepository,
	PaintChatSettingsRepository,
	UsersRepository,
} from '@/models/_.js';
import type { PaintChatParticipant } from '@/models/PaintChatParticipant.js';
import { IdService } from '@/core/IdService.js';
import { bindThis } from '@/decorators.js';

// bot投稿、ステガノグラフィ埋め込み、品質ガードを担当するサービス
@Injectable()
export class PaintChatPublishService {
	constructor(
		@Inject(DI.paintChatPublishesRepository)
		private paintChatPublishesRepository: PaintChatPublishesRepository,

		@Inject(DI.paintChatSettingsRepository)
		private paintChatSettingsRepository: PaintChatSettingsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
	) {
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
}
