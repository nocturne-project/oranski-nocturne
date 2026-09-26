/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AccessTokensRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { SlackNotificationService } from '@/core/SlackNotificationService.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { findBlockedAuthApp } from '@/misc/blocked-auth-apps.js';
import { ApiError } from '@/server/api/error.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	tags: ['auth'],

	requireCredential: true,

	secure: true,

	errors: {
		blockedApp: {
			message: 'This application is blocked by the administrator.',
			code: 'BLOCKED_APP',
			id: '7750f7bf-fd7a-4cac-8703-596e4b1c3bb2',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			token: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		session: { type: 'string', nullable: true },
		name: { type: 'string', nullable: true },
		description: { type: 'string', nullable: true },
		iconUrl: { type: 'string', nullable: true },
		callback: { type: 'string', nullable: true },
		permission: { type: 'array', uniqueItems: true, items: {
			type: 'string',
		} },
	},
	required: ['session', 'permission'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.accessTokensRepository)
		private accessTokensRepository: AccessTokensRepository,

		private idService: IdService,
		private notificationService: NotificationService,
		private slackNotificationService: SlackNotificationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const blocked = findBlockedAuthApp({
				name: ps.name,
				urls: [ps.callback, ps.iconUrl],
			});
			if (blocked != null) {
				this.slackNotificationService.sendAuthAppNotification({
					kind: 'blocked',
					flow: 'MiAuth',
					appName: ps.name,
					callback: ps.callback,
					username: me.username,
					blockedBy: `${blocked.by}: ${blocked.pattern}`,
					permission: ps.permission,
				}).catch(() => {});
				throw new ApiError(meta.errors.blockedApp);
			}

			// アプリ名を変えて再連携してきた場合に気づけるよう、初めて見る名前は通知する
			const isNewApp = ps.name != null && ps.name !== '' && !(await this.accessTokensRepository.exists({
				where: { name: ps.name },
			}));

			// Generate access token
			const accessToken = secureRndstr(32);

			const now = new Date();

			// Insert access token doc
			await this.accessTokensRepository.insert({
				id: this.idService.gen(now.getTime()),
				lastUsedAt: now,
				session: ps.session,
				userId: me.id,
				token: accessToken,
				hash: accessToken,
				name: ps.name,
				description: ps.description,
				iconUrl: ps.iconUrl,
				permission: ps.permission,
			});

			if (isNewApp) {
				this.slackNotificationService.sendAuthAppNotification({
					kind: 'new',
					flow: 'MiAuth',
					appName: ps.name,
					callback: ps.callback,
					username: me.username,
					permission: ps.permission,
				}).catch(() => {});
			}

			// アクセストークンが生成されたことを通知
			this.notificationService.createNotification(me.id, 'createToken', {});

			return {
				token: accessToken,
			};
		});
	}
}
