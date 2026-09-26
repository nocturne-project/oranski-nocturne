/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 拒否対象はリポジトリに書かず、デプロイ側の環境変数で与える
// MISSKEY_BLOCKED_AUTH_APP_NAMES: アプリ名（NFKC・小文字化した上での部分一致）
// MISSKEY_BLOCKED_AUTH_APP_HOSTS: コールバック等のホスト（完全一致＋サブドメイン）

export type BlockedAuthAppMatch = {
	by: 'name' | 'host';
	pattern: string;
};

function parseList(value: string | undefined): string[] {
	return (value ?? '').split(',').map(v => v.trim().toLowerCase()).filter(v => v !== '');
}

function normalizeName(name: string): string {
	return name.normalize('NFKC').toLowerCase().replace(/\s/g, '');
}

// http(s) はホスト単位で、それ以外（カスタムスキーム等）はURL文字列全体で見る
function extractHost(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		return parsed.hostname.toLowerCase();
	} catch {
		return null;
	}
}

export function findBlockedAuthApp(app: {
	name?: string | null;
	urls?: (string | null | undefined)[];
}): BlockedAuthAppMatch | null {
	const blockedNames = parseList(process.env.MISSKEY_BLOCKED_AUTH_APP_NAMES);
	const blockedHosts = parseList(process.env.MISSKEY_BLOCKED_AUTH_APP_HOSTS);

	if (app.name != null && blockedNames.length > 0) {
		const name = normalizeName(app.name);
		const pattern = blockedNames.find(p => name.includes(normalizeName(p)));
		if (pattern != null) return { by: 'name', pattern };
	}

	if (blockedHosts.length > 0) {
		for (const url of app.urls ?? []) {
			if (url == null || url === '') continue;
			const host = extractHost(url);
			// カスタムスキーム等でホストが取れない場合はURL文字列の部分一致で見る
			const pattern = host != null
				? blockedHosts.find(p => host === p || host.endsWith(`.${p}`))
				: blockedHosts.find(p => url.toLowerCase().includes(p));
			if (pattern != null) return { by: 'host', pattern };
		}
	}

	return null;
}
