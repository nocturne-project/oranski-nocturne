/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { DI } from '@/di-symbols.js';
import type { PaintChatParticipantsRepository } from '@/models/_.js';
import type { PaintChatParticipant } from '@/models/PaintChatParticipant.js';
import { ApiError } from '@/server/api/error.js';

// 色設定を保存する。リロード時に復元するために使用。
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: 'f1a2b3c4-paint-chat-save-colors-denied',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
		currentColor: { type: 'string', minLength: 4, maxLength: 9 },
		colorHistory: {
			type: 'array',
			items: { type: 'string', minLength: 4, maxLength: 9 },
			maxItems: 10,
		},
		penWidth: { type: 'number', minimum: 1, maximum: 400 },
		eraserWidth: { type: 'number', minimum: 1, maximum: 400 },
		pressureEnabled: { type: 'boolean' },
	},
	required: ['roomId', 'currentColor', 'colorHistory'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.paintChatParticipantsRepository)
		private paintChatParticipantsRepository: PaintChatParticipantsRepository,

		private paintChatService: PaintChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// アクセス権限チェック
			const canAccess = await this.paintChatService.canAccessRoom(ps.roomId, me.id);
			if (!canAccess) throw new ApiError(meta.errors.accessDenied);

			// 参加者レコードのツール設定を保存
			const prefs: NonNullable<PaintChatParticipant['colorPreferences']> = {
				currentColor: ps.currentColor,
				colorHistory: ps.colorHistory,
				...(ps.penWidth != null ? { penWidth: ps.penWidth } : {}),
				...(ps.eraserWidth != null ? { eraserWidth: ps.eraserWidth } : {}),
				...(ps.pressureEnabled != null ? { pressureEnabled: ps.pressureEnabled } : {}),
			};

			await this.paintChatParticipantsRepository.update(
				{ roomId: ps.roomId, userId: me.id },
				{ colorPreferences: prefs },
			);
		});
	}
}
