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
	requireAdmin: true,
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
			// まず設定が存在することを保証
			await this.paintChatService.getSettings();

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

			// お題リスト
			if (ps.topicList !== undefined) {
				updateData.topicList = ps.topicList;
			}

			// 注意事項テキスト
			if (ps.noticeText !== undefined) {
				updateData.noticeText = ps.noticeText;
			}

			await this.paintChatSettingsRepository.update({}, updateData);

			return { success: true };
		});
	}
}
