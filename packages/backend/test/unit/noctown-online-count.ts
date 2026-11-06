/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { IsNull } from 'typeorm';
import Endpoint, { meta } from '@/server/api/endpoints/noctown/online-count.js';

describe('noctown/online-count', () => {
	test('認証なしで呼べる読み取り専用の設定になっている', () => {
		expect(meta.requireCredential).toBe(false);
		expect(meta.allowGet).toBe(true);
		expect(meta.cacheSec).toBeGreaterThan(0);
		expect(meta.limit.max).toBeGreaterThan(0);
	});

	test('公開ワールドのオンライン件数だけを返す（認証なし・名前などを含まない）', async () => {
		const countBy = jest.fn().mockResolvedValue(12);
		const ep = new Endpoint({ countBy } as any);

		const res = await ep.exec({}, null, null);

		expect(res).toEqual({ online: 12 });
		expect(Object.keys(res)).toEqual(['online']);
		// プライベートルーム（currentWorldId が非 null）は数えない
		expect(countBy).toHaveBeenCalledWith({ isOnline: true, currentWorldId: IsNull() });
	});

	test('0 人のときも 0 を返す', async () => {
		const ep = new Endpoint({ countBy: jest.fn().mockResolvedValue(0) } as any);
		expect(await ep.exec({}, null, null)).toEqual({ online: 0 });
	});
});
