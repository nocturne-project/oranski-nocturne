/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { prefer } from '@/preferences.js';

/**
 * 左ナビに「ノクターンゲームズ」を全員に出すための一度きりの移行。
 *
 * 保存済みのメニュー（並べ替え済みの人）には noctuneGames が入っていないので、
 * 初回だけ chat の直下（無ければ末尾）に足し、足したことを noctuneGamesNavAdded に残す。
 * 印を残すので、利用者がナビの設定で消した場合は、そのあと再び足し直さない（消せる）。
 */
export function addNoctuneGamesToNavbarOnce(): void {
	if (prefer.s.noctuneGamesNavAdded) return;

	const menu = prefer.s.menu;
	if (!menu.includes('noctuneGames')) {
		const chatIndex = menu.indexOf('chat');
		const next = [...menu];
		next.splice(chatIndex >= 0 ? chatIndex + 1 : next.length, 0, 'noctuneGames');
		prefer.commit('menu', next);
	}
	prefer.commit('noctuneGamesNavAdded', true);
}
