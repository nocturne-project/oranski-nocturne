/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, onUnmounted } from 'vue';
import { useStream } from '@/stream.js';
import type { StrokeData, ChatMessage, MatchedEvent, PresenceStatus } from './room.types.js';

// paintChatチャネルへのWebSocket接続とイベント送受信を管理するモジュール
export function usePaintChatConnection(roomId: string) {
	const stream = useStream();
	const connection = ref<ReturnType<typeof stream.useChannel> | null>(null);

	// イベントハンドラの登録先
	const handlers = {
		stroke: [] as Array<(data: StrokeData) => void>,
		progress: [] as Array<(data: { participantId: string; points: any[] }) => void>,
		cursor: [] as Array<(data: { participantId: string; x: number; y: number }) => void>,
		canvasCleared: [] as Array<(data: { participantId: string }) => void>,
		undone: [] as Array<(data: { participantId: string; strokeId: string }) => void>,
		message: [] as Array<(data: ChatMessage) => void>,
		presenceUpdate: [] as Array<(data: { participantId: string; status: PresenceStatus }) => void>,
		partnerLeft: [] as Array<(data: Record<string, never>) => void>,
		partnerReconnected: [] as Array<(data: Record<string, never>) => void>,
		publishRequested: [] as Array<(data: { participantId: string }) => void>,
		publishRejected: [] as Array<(data: Record<string, never>) => void>,
		publishAgreed: [] as Array<(data: Record<string, never>) => void>,
		published: [] as Array<(data: { noteId: string }) => void>,
		sessionEnded: [] as Array<(data: { reason: string }) => void>,
	};

	// チャネルに接続する（paintChatチャネルはmisskey-jsの型定義に含まれないためas any経由）
	function connect() {
		if (connection.value != null) return;

		const ch = (stream as any).useChannel('paintChat', { roomId });

		// 全イベントのリスナーを登録
		for (const [event, handlerList] of Object.entries(handlers)) {
			ch.on(event, (data: any) => {
				for (const handler of handlerList) {
					handler(data);
				}
			});
		}

		connection.value = ch;
	}

	// チャネルを切断する
	function disconnect() {
		if (connection.value != null) {
			connection.value.dispose();
			connection.value = null;
		}
	}

	// イベントハンドラを登録する
	function on<K extends keyof typeof handlers>(event: K, handler: (typeof handlers)[K][number]) {
		(handlers[event] as any[]).push(handler);
	}

	// --- 送信系メソッド ---

	// paintChatチャネルはmisskey-jsの型定義に含まれないため、sendをany経由で呼び出す
	function channelSend(type: string, body: Record<string, unknown>) {
		(connection.value as any)?.send(type, body);
	}

	// ストローク完了を送信する
	function sendStroke(stroke: Omit<StrokeData, 'participantId'>) {
		channelSend('drawingStroke', stroke as Record<string, unknown>);
	}

	// 描画進行中データを送信する
	function sendProgress(points: Array<{ x: number; y: number }>) {
		channelSend('drawingProgress', { points });
	}

	// カーソル位置を送信する
	function sendCursorMove(x: number, y: number) {
		channelSend('cursorMove', { x, y });
	}

	// キャンバスクリアを送信する
	function sendClearCanvas() {
		channelSend('clearCanvas', {});
	}

	// アンドゥを送信する
	function sendUndo() {
		channelSend('undoStroke', {});
	}

	// プレゼンス状態を送信する
	function sendPresence(status: PresenceStatus) {
		channelSend('presence', { status });
	}

	// コンポーネント破棄時に自動切断
	onUnmounted(() => {
		disconnect();
	});

	return {
		connect,
		disconnect,
		on,
		sendStroke,
		sendProgress,
		sendCursorMove,
		sendClearCanvas,
		sendUndo,
		sendPresence,
	};
}
