/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// ステガノグラフィモジュール
// LSB方式（PNG向け、高精度）+ ブロック明度変調方式（JPEG耐性、ロバスト）のデュアル方式。
// 埋め込み: 両方式で同時に埋め込む
// 抽出: まずLSBを試行、失敗したらブロック明度方式で抽出

const MAGIC_HEADER = 'PC'; // Paint Chat マジックヘッダー（2バイト）
const BLOCK_SIZE = 8; // ブロック明度方式の1ブロックのピクセルサイズ
const STRENGTH = 3; // 明度変調の強度（値が大きいほどロバストだが目立つ）

// --- ヘルパー ---

// 文字列をビット列に変換する
function stringToBits(str: string): number[] {
	const bits: number[] = [];
	for (let i = 0; i < str.length; i++) {
		const charCode = str.charCodeAt(i);
		for (let bit = 7; bit >= 0; bit--) {
			bits.push((charCode >> bit) & 1);
		}
	}
	return bits;
}

// ビット列をバイト列に変換する
function bitsToBytes(bits: number[]): number[] {
	const bytes: number[] = [];
	for (let i = 0; i + 7 < bits.length; i += 8) {
		let byte = 0;
		for (let bit = 0; bit < 8; bit++) {
			byte = (byte << 1) | bits[i + bit];
		}
		bytes.push(byte);
	}
	return bytes;
}

// ペイロードを構築する（マジックヘッダー + ID長 + ルームID）
function buildPayload(roomId: string): string {
	return MAGIC_HEADER + String.fromCharCode(roomId.length) + roomId;
}

// --- LSB方式（PNG向け、高精度） ---

// LSB方式でルームIDを埋め込む
function embedLSB(data: Uint8ClampedArray, bits: number[]): void {
	let bitIndex = 0;
	for (let i = 0; i < data.length && bitIndex < bits.length; i++) {
		if (i % 4 === 3) continue; // Aチャネルはスキップ
		data[i] = (data[i] & 0xFE) | bits[bitIndex];
		bitIndex++;
	}
}

// LSB方式でルームIDを抽出する
function extractLSB(data: Uint8ClampedArray): string | null {
	const bits: number[] = [];
	for (let i = 0; i < data.length; i++) {
		if (i % 4 === 3) continue;
		bits.push(data[i] & 1);
		if (bits.length >= 280) break; // マジック2+長さ1+最大ID32 = 35バイト = 280ビット
	}
	return decodePayload(bitsToBytes(bits));
}

// --- ブロック明度変調方式（JPEG耐性、ロバスト） ---
// 8x8ピクセルブロックの平均明度を微調整してビットを埋め込む。
// ビット0: 明度を偶数方向に丸める、ビット1: 明度を奇数方向に丸める。
// JPEG圧縮後もブロック平均値は概ね保持されるためロバスト。

// ブロック明度方式でルームIDを埋め込む
function embedBlock(data: Uint8ClampedArray, width: number, height: number, bits: number[]): void {
	const blocksX = Math.floor(width / BLOCK_SIZE);
	const blocksY = Math.floor(height / BLOCK_SIZE);
	let bitIndex = 0;

	for (let by = 0; by < blocksY && bitIndex < bits.length; by++) {
		for (let bx = 0; bx < blocksX && bitIndex < bits.length; bx++) {
			// ブロックの平均明度を計算
			let sum = 0;
			let count = 0;
			for (let py = 0; py < BLOCK_SIZE; py++) {
				for (let px = 0; px < BLOCK_SIZE; px++) {
					const x = bx * BLOCK_SIZE + px;
					const y = by * BLOCK_SIZE + py;
					const idx = (y * width + x) * 4;
					// 明度 = (R + G + B) / 3
					sum += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
					count++;
				}
			}
			const avgBrightness = Math.round(sum / count);

			// ビットに応じて明度を変調
			const targetBit = bits[bitIndex];
			const currentParity = avgBrightness % 2;
			const delta = targetBit !== currentParity ? STRENGTH : 0;

			if (delta !== 0) {
				// ブロック全ピクセルの明度をdelta分シフト
				for (let py = 0; py < BLOCK_SIZE; py++) {
					for (let px = 0; px < BLOCK_SIZE; px++) {
						const x = bx * BLOCK_SIZE + px;
						const y = by * BLOCK_SIZE + py;
						const idx = (y * width + x) * 4;
						data[idx] = Math.min(255, Math.max(0, data[idx] + delta));
						data[idx + 1] = Math.min(255, Math.max(0, data[idx + 1] + delta));
						data[idx + 2] = Math.min(255, Math.max(0, data[idx + 2] + delta));
					}
				}
			}

			bitIndex++;
		}
	}
}

// ブロック明度方式でルームIDを抽出する
function extractBlock(data: Uint8ClampedArray, width: number, height: number): string | null {
	const blocksX = Math.floor(width / BLOCK_SIZE);
	const blocksY = Math.floor(height / BLOCK_SIZE);
	const bits: number[] = [];

	for (let by = 0; by < blocksY && bits.length < 280; by++) {
		for (let bx = 0; bx < blocksX && bits.length < 280; bx++) {
			let sum = 0;
			let count = 0;
			for (let py = 0; py < BLOCK_SIZE; py++) {
				for (let px = 0; px < BLOCK_SIZE; px++) {
					const x = bx * BLOCK_SIZE + px;
					const y = by * BLOCK_SIZE + py;
					const idx = (y * width + x) * 4;
					sum += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
					count++;
				}
			}
			const avgBrightness = Math.round(sum / count);
			bits.push(avgBrightness % 2);
		}
	}

	return decodePayload(bitsToBytes(bits));
}

// --- ペイロードデコード ---

// バイト列からルームIDをデコードする
function decodePayload(bytes: number[]): string | null {
	if (bytes.length < 3) return null;
	const header = String.fromCharCode(bytes[0], bytes[1]);
	if (header !== MAGIC_HEADER) return null;

	const idLength = bytes[2];
	if (idLength <= 0 || idLength > 32) return null;
	if (bytes.length < 3 + idLength) return null;

	let roomId = '';
	for (let i = 0; i < idLength; i++) {
		roomId += String.fromCharCode(bytes[3 + i]);
	}
	return roomId;
}

// --- 公開API ---

// ルームIDをキャンバス画像に埋め込む（LSB + ブロック明度の両方式）
export function embedRoomId(canvas: HTMLCanvasElement, roomId: string): HTMLCanvasElement {
	const ctx = canvas.getContext('2d');
	if (!ctx) return canvas;

	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const payload = buildPayload(roomId);
	const bits = stringToBits(payload);

	// LSB方式で埋め込み（PNG向け高精度）
	embedLSB(imageData.data, bits);

	// ブロック明度変調方式で埋め込み（JPEG耐性ロバスト）
	embedBlock(imageData.data, canvas.width, canvas.height, bits);

	ctx.putImageData(imageData, 0, 0);
	return canvas;
}

// 画像からルームIDを抽出する（LSB -> ブロック明度のフォールバック）
export function extractRoomId(canvas: HTMLCanvasElement): string | null {
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;

	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

	// まずLSB方式で試行（PNG画像ならこちらで成功する）
	const lsbResult = extractLSB(imageData.data);
	if (lsbResult != null) return lsbResult;

	// LSBが失敗した場合はブロック明度方式で試行（JPEG再圧縮後の画像）
	return extractBlock(imageData.data, canvas.width, canvas.height);
}

// キャンバスをステガノグラフィ付きでダウンロードする
export function downloadWithSteganography(
	canvas: HTMLCanvasElement,
	roomId: string,
	filename: string,
): void {
	const offscreen = window.document.createElement('canvas');
	offscreen.width = canvas.width;
	offscreen.height = canvas.height;
	const offCtx = offscreen.getContext('2d')!;
	offCtx.drawImage(canvas, 0, 0);

	embedRoomId(offscreen, roomId);

	const link = window.document.createElement('a');
	link.download = filename;
	link.href = offscreen.toDataURL('image/png');
	link.click();
}
