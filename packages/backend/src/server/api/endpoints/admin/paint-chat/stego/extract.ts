/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { ApiError } from '@/server/api/error.js';
import { DownloadService } from '@/core/DownloadService.js';

// admin/moderator: 画像からステガノグラフィでルームIDを抽出する
export const meta = {
	tags: ['admin', 'paint-chat'],
	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:paint-chat',

	errors: {
		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: '7444a5a2-85ce-4755-8c5d-4c6f18a3027b',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			found: { type: 'boolean', optional: false, nullable: false },
			roomId: { type: 'string', optional: true, nullable: true },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileId: { type: 'string', format: 'misskey:id' },
	},
	required: ['fileId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,
	) {
		super(meta, paramDef, async (ps, me) => {
			const file = await this.driveFilesRepository.findOneBy({ id: ps.fileId });
			if (file == null) throw new ApiError(meta.errors.noSuchFile);

			// ステガノグラフィの抽出はサーバー側では画像バイナリの処理が必要
			// 現時点ではフロントエンド側のCanvas APIで抽出する方式を推奨
			// サーバー側の完全な実装は画像処理ライブラリ追加後に対応予定
			return {
				found: false,
				roomId: null,
			};
		});
	}
}
