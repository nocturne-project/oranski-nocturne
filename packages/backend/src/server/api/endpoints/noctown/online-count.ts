/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { NoctownPlayersRepository } from '@/models/_.js';

// 認証なしで「いまノクタウン（公開ワールド）にいる人の件数」だけを返す。
// 名前・ID・位置などは返さない。プライベートルーム（currentWorldId が非 null）は数えない。
export const meta = {
	tags: ['noctown'],

	requireCredential: false,
	allowGet: true,
	cacheSec: 3,

	// IP ごとのレート制限（未ログインは IP で判定される）
	limit: {
		duration: 1000 * 10,
		max: 20,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			online: { type: 'integer', optional: false, nullable: false },
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
		@Inject(DI.noctownPlayersRepository)
		private noctownPlayersRepository: NoctownPlayersRepository,
	) {
		super(meta, paramDef, async () => {
			const online = await this.noctownPlayersRepository.countBy({
				isOnline: true,
				currentWorldId: IsNull(),
			});
			return { online };
		});
	}
}
