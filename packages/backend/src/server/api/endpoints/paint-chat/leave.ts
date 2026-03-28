/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { PaintChatMatchingService } from '@/core/PaintChatMatchingService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApiError } from '@/server/api/error.js';

// ルームから明示的に退出する
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: '25005ba1-98a3-4cc4-98b0-587f6a425944',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			success: {
				type: 'boolean',
				optional: false, nullable: false,
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private paintChatService: PaintChatService,
		private paintChatMatchingService: PaintChatMatchingService,
		private globalEventService: GlobalEventService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const participant = await this.paintChatService.resolveParticipant(ps.roomId, me.id);
			if (participant == null) throw new ApiError(meta.errors.accessDenied);

			// ルームを終了する
			await this.paintChatService.endRoom(ps.roomId);

			// マッチングキューから自分を削除（残留エントリを防止。相手は次回join時に自動クリーンアップされる）
			await this.paintChatMatchingService.leaveQueue(me.id).catch(() => {});

			// 相手に退出を通知
			this.globalEventService.publishPaintChatStream(ps.roomId, 'partnerLeft', {} as any);

			return { success: true };
		});
	}
}
