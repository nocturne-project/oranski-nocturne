/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { DI } from '@/di-symbols.js';
import type { UsersRepository, PaintChatSettingsRepository } from '@/models/_.js';
import { ApiError } from '@/server/api/error.js';

// admin: ランダム絵チャット設定更新
export const meta = {
	tags: ['admin', 'paint-chat'],
	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'write:admin:paint-chat',

	errors: {
		noSuchUser: {
			message: 'No such user.',
			code: 'NO_SUCH_USER',
			id: '0b4ccb74-050a-404c-b461-46e49a263d79',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			success: { type: 'boolean', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		botAccountUsername: { type: 'string', nullable: true },
		topicList: { type: 'string' },
		topicListSpring: { type: 'string' },
		topicListSummer: { type: 'string' },
		topicListAutumn: { type: 'string' },
		topicListWinter: { type: 'string' },
		noticeText: { type: 'string' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.paintChatSettingsRepository)
		private paintChatSettingsRepository: PaintChatSettingsRepository,

		private paintChatService: PaintChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// 設定レコードを取得（なければ作成される）
			await this.paintChatService.getSettings();
			const setting = await this.paintChatSettingsRepository.findOne({ where: {} });
			if (setting == null) throw new Error('Failed to get paint chat settings');

			const updateData: Record<string, any> = {
				updatedAt: new Date(),
			};

			// botアカウント設定
			if (ps.botAccountUsername !== undefined) {
				if (ps.botAccountUsername === null || ps.botAccountUsername === '') {
					updateData.botAccountId = null as any;
				} else {
					const botUser = await this.usersRepository.findOneBy({
						username: ps.botAccountUsername,
						host: IsNull(),
					});
					if (!botUser) throw new ApiError(meta.errors.noSuchUser);
					updateData.botAccountId = botUser.id;
				}
			}

			// お題リスト（汎用 + 季節別）
			if (ps.topicList !== undefined) updateData.topicList = ps.topicList;
			if (ps.topicListSpring !== undefined) updateData.topicListSpring = ps.topicListSpring;
			if (ps.topicListSummer !== undefined) updateData.topicListSummer = ps.topicListSummer;
			if (ps.topicListAutumn !== undefined) updateData.topicListAutumn = ps.topicListAutumn;
			if (ps.topicListWinter !== undefined) updateData.topicListWinter = ps.topicListWinter;

			// 注意事項テキスト
			if (ps.noticeText !== undefined) {
				updateData.noticeText = ps.noticeText;
			}

			// IDを指定して更新（空条件のupdateはTypeORMでエラーになるため）
			await this.paintChatSettingsRepository.update(setting.id, updateData);

			return { success: true };
		});
	}
}
