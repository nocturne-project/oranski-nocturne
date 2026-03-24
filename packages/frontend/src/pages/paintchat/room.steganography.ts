/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// LSB（最下位ビット）ステガノグラフィ。ルームIDをPNG画像のRGBチャネルのLSBに埋め込む。

const MAGIC_HEADER = 'PC'; // Paint Chat マジックヘッダー（2バイト）

// ルームIDをキャンバス画像に埋め込む
export function embedRoomId(canvas: HTMLCanvasElement, roomId: string): HTMLCanvasElement {
	const ctx = canvas.getContext('2d');
	if (!ctx) return canvas;

	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const data = imageData.data; // RGBA配列

	// 埋め込むデータ: マジックヘッダー + ルームID長(1バイト) + ルームID
	const payload = MAGIC_HEADER + String.fromCharCode(roomId.length) + roomId;
	const bits: number[] = [];

	// 文字列をビット列に変換
	for (let i = 0; i < payload.length; i++) {
		const charCode = payload.charCodeAt(i);
		for (let bit = 7; bit >= 0; bit--) {
			bits.push((charCode >> bit) & 1);
		}
	}

	// ビットをRGBチャネルのLSBに埋め込む（Aチャネルはスキップ）
	let bitIndex = 0;
	for (let i = 0; i < data.length && bitIndex < bits.length; i++) {
		// Aチャネル(アルファ)はスキップ
		if (i % 4 === 3) continue;

		// LSBを置換
		data[i] = (data[i] & 0xFE) | bits[bitIndex];
		bitIndex++;
	}

	ctx.putImageData(imageData, 0, 0);
	return canvas;
}

// 画像からルームIDを抽出する
export function extractRoomId(canvas: HTMLCanvasElement): string | null {
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;

	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const data = imageData.data;

	// RGBチャネルのLSBからビットを取得
	const bits: number[] = [];
	for (let i = 0; i < data.length; i++) {
		if (i % 4 === 3) continue; // Aチャネルはスキップ
		bits.push(data[i] & 1);
		// 十分な量のビットを取得したら終了（マジック2+長さ1+最大ID長32 = 35バイト = 280ビット）
		if (bits.length >= 280) break;
	}

	// ビット列からバイト列に変換
	const bytes: number[] = [];
	for (let i = 0; i + 7 < bits.length; i += 8) {
		let byte = 0;
		for (let bit = 0; bit < 8; bit++) {
			byte = (byte << 1) | bits[i + bit];
		}
		bytes.push(byte);
	}

	// マジックヘッダー確認
	if (bytes.length < 3) return null;
	const header = String.fromCharCode(bytes[0], bytes[1]);
	if (header !== MAGIC_HEADER) return null;

	// ルームID長
	const idLength = bytes[2];
	if (idLength <= 0 || idLength > 32) return null;
	if (bytes.length < 3 + idLength) return null;

	// ルームID抽出
	let roomId = '';
	for (let i = 0; i < idLength; i++) {
		roomId += String.fromCharCode(bytes[3 + i]);
	}

	return roomId;
}

// キャンバスをステガノグラフィ付きでダウンロードする
export function downloadWithSteganography(
	canvas: HTMLCanvasElement,
	roomId: string,
	filename: string,
): void {
	// オフスクリーンキャンバスにコピー
	const offscreen = window.document.createElement('canvas');
	offscreen.width = canvas.width;
	offscreen.height = canvas.height;
	const offCtx = offscreen.getContext('2d')!;
	offCtx.drawImage(canvas, 0, 0);

	// ステガノグラフィ埋め込み
	embedRoomId(offscreen, roomId);

	// ダウンロード
	const link = window.document.createElement('a');
	link.download = filename;
	link.href = offscreen.toDataURL('image/png');
	link.click();
}
