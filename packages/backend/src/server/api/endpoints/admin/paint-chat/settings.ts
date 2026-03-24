/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { DI } from '@/di-symbols.js';
import type { UsersRepository } from '@/models/_.js';

// admin: ランダム絵チャット設定取得
export const meta = {
	tags: ['admin', 'paint-chat'],
	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:paint-chat',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			botAccountId: { type: 'string', optional: false, nullable: true },
			botAccountUsername: { type: 'string', optional: false, nullable: true },
			topicList: { type: 'string', optional: false, nullable: false },
			noticeText: { type: 'string', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private paintChatService: PaintChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const settings = await this.paintChatService.getSettings();

			let botAccountUsername: string | null = null;
			if (settings.botAccountId) {
				const botAccount = await this.usersRepository.findOneBy({ id: settings.botAccountId });
				if (botAccount) {
					botAccountUsername = botAccount.username;
				}
			}

			return {
				botAccountId: settings.botAccountId,
				botAccountUsername,
				topicList: settings.topicList,
				topicListSpring: settings.topicListSpring,
				topicListSummer: settings.topicListSummer,
				topicListAutumn: settings.topicListAutumn,
				topicListWinter: settings.topicListWinter,
				noticeText: settings.noticeText,
			};
		});
	}
}
