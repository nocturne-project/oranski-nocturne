/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * グループチャットお絵描き - WebSocket通信
 * paintchat式に改修: drawingStrokeにpressure配列・layerフィールド追加、
 * カーソル50msレート制限、後方互換性（pressure未定義時は1.0フォールバック）
 */

import type { Ref } from 'vue';
import type { PressurePoint, Point, ToolType, StrokeData, RemoteCursor } from './room.drawing.types.js';
import { getUserCursorColor } from './room.drawing.canvas.js';

// カーソル送信レート制限（50ms）
const CURSOR_SEND_INTERVAL = 50;

// WebSocket通信Composable（CanvasEngine対応版）
export function useDrawingNetwork(deps: {
	connection: Ref<any>;
	currentTool: Ref<ToolType>;
	currentColor: Ref<string>;
	strokeWidth: Ref<number>;
	currentOpacity: Ref<number>;
	currentLayer: Ref<number>;
	otherCursors: Ref<RemoteCursor[]>;
	$i: any;
}) {
	// カーソルタイマー管理（3秒タイムアウト）
	const cursorTimers = new Map<string, number>();
	// カーソル送信レート制限
	let lastCursorSent = 0;

	// 完了ストロークを送信（paintchat式: pressure配列・layer含む）
	function sendDrawingStroke(stroke: StrokeData) {
		if (!deps.connection.value || !stroke) return;

		try {
			const data = {
				id: stroke.id,
				points: stroke.points,
				tool: stroke.tool,
				color: stroke.color,
				strokeWidth: stroke.width ?? stroke.strokeWidth,
				opacity: stroke.opacity,
				layer: stroke.layer ?? 0,
				// 後方互換: 古い受信側がpressure未定義でも動作するようにする
			};
			deps.connection.value.send('drawingStroke', data);
		} catch (error) {
			console.warn('[Drawing] Failed to send stroke:', error);
		}
	}

	// 描画進行中データを送信（レート制限付き）
	function sendDrawingProgress(points: PressurePoint[]) {
		if (!deps.connection.value || points.length === 0) return;

		try {
			const data = {
				points: points.slice(),
				tool: deps.currentTool.value,
				color: deps.currentColor.value,
				strokeWidth: deps.strokeWidth.value,
				opacity: deps.currentOpacity.value,
				layer: deps.currentLayer.value,
			};
			deps.connection.value.send('drawingProgress', data);
		} catch (error) {
			// silent fail for progress
		}
	}

	// カーソル位置を送信（50msレート制限）
	function sendCursorPosition(point: Point) {
		if (!deps.connection.value) return;

		const now = Date.now();
		if (now - lastCursorSent < CURSOR_SEND_INTERVAL) return;
		lastCursorSent = now;

		try {
			deps.connection.value.send('cursorMove', { x: point.x, y: point.y });
		} catch (error) {
			// silent fail for cursor
		}
	}

	// 他ユーザーのカーソルを更新（3秒タイムアウト非表示）
	function updateOtherCursor(data: { userId: string; userName: string; x: number; y: number }) {
		if (data.userId === deps.$i.id) return;

		const color = getUserCursorColor(data.userId);
		const index = deps.otherCursors.value.findIndex(c => c.userId === data.userId);

		const cursorData: RemoteCursor = {
			userId: data.userId,
			userName: data.userName,
			x: data.x,
			y: data.y,
			color,
		};

		if (index >= 0) {
			deps.otherCursors.value[index] = cursorData;
		} else {
			deps.otherCursors.value.push(cursorData);
		}

		// 既存タイマーをクリア
		if (cursorTimers.has(data.userId)) {
			window.clearTimeout(cursorTimers.get(data.userId));
		}

		// 3秒後にカーソルを非表示
		const timer = window.setTimeout(() => {
			const idx = deps.otherCursors.value.findIndex(c => c.userId === data.userId);
			if (idx >= 0) {
				deps.otherCursors.value.splice(idx, 1);
			}
			cursorTimers.delete(data.userId);
		}, 3000);

		cursorTimers.set(data.userId, timer);
	}

	// アンドゥ送信
	function sendUndo(strokeId: string) {
		if (!deps.connection.value) return;
		try {
			deps.connection.value.send('undoStroke', {
				strokeId,
				layer: deps.currentLayer.value,
			});
		} catch (error) {
			console.warn('[Drawing] Failed to send undo:', error);
		}
	}

	// クリア送信
	function sendClearCanvas() {
		if (!deps.connection.value) return;
		try {
			deps.connection.value.send('clearCanvas', {});
		} catch (error) {
			console.warn('[Drawing] Failed to send clear:', error);
		}
	}

	// タイマークリーンアップ
	function dispose() {
		for (const timer of cursorTimers.values()) {
			window.clearTimeout(timer);
		}
		cursorTimers.clear();
	}

	return {
		sendDrawingStroke,
		sendDrawingProgress,
		sendCursorPosition,
		updateOtherCursor,
		sendUndo,
		sendClearCanvas,
		dispose,
	};
}
