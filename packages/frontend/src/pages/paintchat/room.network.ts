/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, onUnmounted } from 'vue';
import { useStream } from '@/stream.js';
import type { StrokeData, ChatMessage, MatchedEvent, PresenceStatus } from './room.types.js';

// 再接続設定（線形バックオフ: 3秒, 6秒, 9秒, ... 最大30秒）
const RECONNECT_BASE_INTERVAL = 3000; // 3秒
const RECONNECT_MAX_INTERVAL = 30000; // 最大30秒
const RECONNECT_MAX_ATTEMPTS = 20; // 最大試行回数（60秒以上の連続失敗で停止）

// paintChatチャネルへのWebSocket接続とイベント送受信を管理するモジュール
export function usePaintChatConnection(roomId: string) {
	const stream = useStream();
	const connection = ref<ReturnType<typeof stream.useChannel> | null>(null);
	const isConnected = ref(false);
	const isReconnecting = ref(false);

	// 再接続用の状態
	let reconnectTimer: number | null = null;
	let reconnectAttempts = 0;
	let intentionalDisconnect = false;

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

	// 再接続成功時コールバック
	const reconnectedCallbacks: Array<() => void> = [];

	// チャネルに接続する
	function connect() {
		if (connection.value != null) return;
		intentionalDisconnect = false;

		try {
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
			isConnected.value = true;
			isReconnecting.value = false;

			// 再接続時はコールバックを実行する（プレゼンスonlineはサーバー側init()で自動送信される）
			if (reconnectAttempts > 0) {
				console.info('[PaintChat] Reconnected after', reconnectAttempts, 'attempts.');
				for (const cb of reconnectedCallbacks) {
					cb();
				}
			}
			reconnectAttempts = 0;
		} catch (e) {
			console.warn('[PaintChat] Connection failed:', e);
			isConnected.value = false;
			scheduleReconnect();
		}
	}

	// チャネルを切断する（意図的な切断）
	function disconnect() {
		intentionalDisconnect = true;
		cancelReconnect();
		if (connection.value != null) {
			connection.value.dispose();
			connection.value = null;
		}
		isConnected.value = false;
		isReconnecting.value = false;
	}

	// 再接続をスケジュールする（線形バックオフ）
	function scheduleReconnect() {
		if (intentionalDisconnect) return;
		if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
			console.warn(`[PaintChat] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Giving up.`);
			isReconnecting.value = false;
			return;
		}

		isReconnecting.value = true;
		reconnectAttempts++;
		const delay = Math.min(RECONNECT_BASE_INTERVAL * reconnectAttempts, RECONNECT_MAX_INTERVAL);
		console.info(`[PaintChat] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

		reconnectTimer = window.setTimeout(() => {
			reconnectTimer = null;
			// 既存の接続を破棄
			if (connection.value != null) {
				try { connection.value.dispose(); } catch { /* ignore */ }
				connection.value = null;
			}
			connect();
		}, delay);
	}

	// 再接続タイマーをキャンセルする
	function cancelReconnect() {
		if (reconnectTimer != null) {
			window.clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	}

	// Misskeyのストリーム切断を検知して再接続する
	// stream自体にdisconnectイベントがある場合はそれを使う
	// なければ定期的に接続状態をチェックする
	let healthCheckTimer: number | null = null;

	function startHealthCheck() {
		healthCheckTimer = window.setInterval(() => {
			if (intentionalDisconnect) return;
			// connectionがnullになっていたら切断と判断
			if (connection.value == null && !isReconnecting.value) {
				console.warn('[PaintChat] Connection lost, scheduling reconnect...');
				scheduleReconnect();
			}
		}, 5000); // 5秒ごとにチェック
	}

	// イベントハンドラを登録する
	function on<K extends keyof typeof handlers>(event: K, handler: (typeof handlers)[K][number]) {
		(handlers[event] as any[]).push(handler);
	}

	// 再接続成功時のコールバックを登録する
	function onReconnected(callback: () => void) {
		reconnectedCallbacks.push(callback);
	}

	// --- 送信系メソッド ---

	function channelSend(type: string, body: Record<string, unknown>) {
		(connection.value as any)?.send(type, body);
	}

	function sendStroke(stroke: Omit<StrokeData, 'participantId'>) {
		channelSend('drawingStroke', stroke as Record<string, unknown>);
	}

	function sendProgress(points: Array<{ x: number; y: number }>) {
		channelSend('drawingProgress', { points });
	}

	function sendCursorMove(x: number, y: number) {
		channelSend('cursorMove', { x, y });
	}

	function sendClearCanvas() {
		channelSend('clearCanvas', {});
	}

	function sendUndo() {
		channelSend('undoStroke', {});
	}

	function sendPresence(status: PresenceStatus) {
		channelSend('presence', { status });
	}

	// ヘルスチェック開始
	startHealthCheck();

	// コンポーネント破棄時に自動切断
	onUnmounted(() => {
		disconnect();
		if (healthCheckTimer != null) {
			window.clearInterval(healthCheckTimer);
			healthCheckTimer = null;
		}
	});

	return {
		connect,
		disconnect,
		on,
		onReconnected,
		isConnected,
		isReconnecting,
		sendStroke,
		sendProgress,
		sendCursorMove,
		sendClearCanvas,
		sendUndo,
		sendPresence,
	};
}
