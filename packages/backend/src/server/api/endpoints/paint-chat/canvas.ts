/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { PaintChatService } from '@/core/PaintChatService.js';
import { PaintChatCanvasService } from '@/core/PaintChatCanvasService.js';
import { ApiError } from '@/server/api/error.js';

// ルームのキャンバスデータ（ストローク一覧）を取得する。リロード時の復元に使用。
export const meta = {
	tags: ['paint-chat'],
	requireCredential: true,
	kind: 'read:account',

	errors: {
		accessDenied: {
			message: 'Access denied.',
			code: 'ACCESS_DENIED',
			id: 'b3c4d5e6-paint-chat-canvas-denied',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
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
		private paintChatCanvasService: PaintChatCanvasService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const canAccess = await this.paintChatService.canAccessRoom(ps.roomId, me.id);
			if (!canAccess) throw new ApiError(meta.errors.accessDenied);

			const strokes = await this.paintChatCanvasService.getStrokes(ps.roomId);
			const mergedImage = await this.paintChatCanvasService.getMergedImage(ps.roomId);

			return {
				strokes,
				mergedImage,
			};
		});
	}
}
