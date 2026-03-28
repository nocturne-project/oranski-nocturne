/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { PaintChatCanvasService } from '@/core/PaintChatCanvasService.js';
import { ApiError } from '@/server/api/error.js';

// 通報する
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'write:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: '71d85103-a106-41c4-9eaa-b555c198c808',
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
		roomId: { type: 'string', format: 'misskey:id' },
		reason: { type: 'string', maxLength: 1000 },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private paintChatService: PaintChatService,
		private paintChatCanvasService: PaintChatCanvasService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const participant = await this.paintChatService.resolveParticipant(ps.roomId, me.id);
			if (participant == null) throw new ApiError(meta.errors.accessDenied);

			// 相手の参加者を特定
			const participants = await this.paintChatService.getRoomParticipants(ps.roomId);
			const target = participants.find(p => p.id !== participant.id);
			if (!target) throw new ApiError(meta.errors.accessDenied);

			// 通報処理（通報レコード作成 + 再マッチング除外 + isReportedフラグ）
			await this.paintChatService.reportRoom(
				ps.roomId,
				participant.id,
				me.id,
				target.userId,
				ps.reason,
			);

			// 通報されたルームのRedisデータのTTLを無期限にする
			await this.paintChatCanvasService.removeExpiry(ps.roomId);

			return { success: true };
		});
	}
}
