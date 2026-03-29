<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only

【お絵かきチャットコンポーネント】
このコンポーネントは、チャットルーム（複数人）とユーザー間DM（1対1）の両方で使用されます。

■ 対応するチャット形式:
1. チャットルーム (chatRoom)
   - URLパターン: /chat/room/:roomId#drawing
   - props.roomId が存在する場合
   - drawingId形式: roomId (そのまま)
   - WebSocketチャンネル: 'chatRoom'

2. ユーザー間DM (chatUser)
   - URLパターン: /chat/user/:userId#drawing
   - props.userId が存在する場合
   - drawingId形式: user-{sortedUserId1}-{sortedUserId2}
   - WebSocketチャンネル: 'chatUser'

■ チャンネル切り替えロジック:
- props.userId が存在する場合 → chatUser チャンネルを使用
- props.roomId が存在する場合 → chatRoom チャンネルを使用
- 両チャンネルで同じお絵かきイベントをサポート:
  - drawingStroke, drawingProgress, cursorMove
  - clearCanvas, undoStroke, redoStroke, canvasSizeChange

■ キャンバスデータの保存先:
- Redis: リアルタイムの描画ストローク (drawingId をキーとして)
- PostgreSQL: ユーザー設定 (ツール、色、レイヤー設定など)
- PostgreSQL: ルーム設定 (キャンバスサイズ)
-->

<template>
<div :class="[$style.root, 'drawing-root']" style="display: flex; flex-direction: row;">
	<!-- paintchat式左サイドバーツールバー（パネル展開方式） -->
	<div :class="$style.toolbar">
		<!-- 移動（パン）ツール -->
		<button :class="[$style.toolButton, { [$style.active]: isMoveMode }]" title="移動" @click="toggleMoveMode">
			<i class="ti ti-arrows-move"></i>
		</button>
		<!-- ペン -->
		<button :class="[$style.toolButton, { [$style.active]: !isMoveMode && currentTool === 'pen' }]" title="ペン" @click="setTool('pen')">
			<i class="ti ti-pencil"></i>
		</button>
		<!-- 消しゴム -->
		<button :class="[$style.toolButton, { [$style.active]: currentTool === 'eraser' }]" title="消しゴム" @click="setTool('eraser')">
			<i class="ti ti-eraser"></i>
		</button>
		<!-- スポイト -->
		<button :class="[$style.toolButton, { [$style.active]: currentTool === 'eyedropper' }]" title="スポイト" @click="setTool('eyedropper')">
			<i class="ti ti-color-picker"></i>
		</button>

		<!-- 色（現在色のドット、クリックでパネル展開） -->
		<button :class="$style.toolButton" title="色選択" @click="toggleToolPanel('color')">
			<span :class="$style.colorDot" :style="{ background: currentColor }"></span>
		</button>

		<!-- 太さ（クリックでパネル展開） -->
		<button :class="$style.toolButton" title="太さ / 透明度" @click="toggleToolPanel('width')">
			<i class="ti ti-line-height"></i>
		</button>

		<div :class="$style.separator"></div>

		<!-- レイヤー（クリックでパネル展開） -->
		<button :class="$style.toolButton" title="レイヤー" @click="toggleToolPanel('layer')">
			<span :class="$style.layerIcon">L{{ currentLayer + 1 }}</span>
		</button>

		<!-- アンドゥ -->
		<button :class="[$style.toolButton, { [$style.disabled]: !canUndo }]" :disabled="!canUndo" title="戻す" @click="undo">
			<i class="ti ti-arrow-back-up"></i>
		</button>

		<!-- ズーム -->
		<button :class="$style.toolButton" title="縮小" @click="zoomOut"><i class="ti ti-zoom-out"></i></button>
		<button :class="$style.toolButton" title="拡大" @click="zoomIn"><i class="ti ti-zoom-in"></i></button>

		<div :class="$style.separator"></div>

		<!-- ダウンロード（クリックでパネル展開） -->
		<button :class="$style.toolButton" title="保存" @click="toggleToolPanel('download')">
			<i class="ti ti-download"></i>
		</button>

		<div :class="$style.separator"></div>

		<!-- チャット（未読時点滅） -->
		<button :class="[$style.toolButton, { [$style.highlight]: drawingChatRef?.hasUnread }]" title="チャット" @click="toggleDrawingChat">
			<i class="ti ti-message-circle"></i>
		</button>

		<!-- その他（グループチャット固有機能） -->
		<button :class="[$style.toolButton, { [$style.active]: activeToolPanel === 'more' }]" title="その他" @click="toggleToolPanel('more')">
			<i class="ti ti-dots"></i>
		</button>
	</div>

	<!-- 展開パネル（サイドバーの右隣に表示、paintchat同様） -->
	<div v-if="activeToolPanel" :class="$style.toolPanel">
		<div :class="$style.toolPanelHeader">
			<span v-if="activeToolPanel === 'color'">色選択</span>
			<span v-else-if="activeToolPanel === 'width'">太さ / 透明度</span>
			<span v-else-if="activeToolPanel === 'layer'">レイヤー</span>
			<span v-else-if="activeToolPanel === 'download'">保存</span>
			<span v-else-if="activeToolPanel === 'more'">その他</span>
			<button :class="$style.toolPanelClose" @click="activeToolPanel = null">閉じる</button>
		</div>

		<!-- カラー選択パネル -->
		<template v-if="activeToolPanel === 'color'">
			<div :class="$style.colorPickerRow">
				<input type="color" :value="currentColor" :class="$style.nativeColorPicker" @input="(e: any) => setColor(e.target.value)">
				<span :class="$style.colorHex">{{ currentColor }}</span>
			</div>
			<div :class="$style.panelLabel">プリセット</div>
			<div :class="$style.colorGrid">
				<button
					v-for="(color, index) in colors"
					:key="index"
					:class="[$style.colorCell, { [$style.colorSelected]: currentColor === color }]"
					:style="{ background: color }"
					@click="setColor(color, index); activeToolPanel = null"
				></button>
			</div>
			<!-- カラーヒストリー（最近使った色） -->
			<template v-if="colorHistory.length > 0">
				<div :class="$style.panelLabel">最近使った色</div>
				<div :class="$style.colorGrid">
					<button
						v-for="(color, idx) in colorHistory"
						:key="'h-' + idx"
						:class="[$style.colorCell, { [$style.colorSelected]: currentColor === color }]"
						:style="{ background: color }"
						@click="setColor(color); activeToolPanel = null"
					></button>
				</div>
			</template>
		</template>

		<!-- 太さ + 透明度パネル -->
		<template v-if="activeToolPanel === 'width'">
			<div :class="$style.pressureToggle">
				<label :class="$style.toggleLabel">
					<input type="checkbox" :checked="pressureEnabled" @change="togglePressure">
					<span>筆圧 {{ pressureEnabled ? 'ON' : 'OFF' }}</span>
				</label>
			</div>
			<div :class="$style.panelLabel">太さ</div>
			<div :class="$style.widthGrid">
				<button
					v-for="w in strokeWidthLevels"
					:key="w"
					:class="[$style.widthCell, { [$style.widthSelected]: strokeWidth === w }]"
					@click="setStrokeWidth(w)"
				>
					<span :class="$style.widthCircle" :style="{ width: Math.min(w * 2, 20) + 'px', height: Math.min(w * 2, 20) + 'px' }"></span>
					<span :class="$style.widthLabel">{{ w }}</span>
				</button>
			</div>
			<div :class="$style.panelLabel">透明度: {{ Math.round(currentOpacity * 100) }}%</div>
			<input
				type="range"
				min="10"
				max="100"
				:value="currentOpacity * 100"
				:class="$style.opacitySlider"
				@input="(e: any) => setOpacity(Number(e.target.value) / 100)"
			>
		</template>

		<!-- レイヤーパネル -->
		<template v-if="activeToolPanel === 'layer'">
			<button
				v-for="i in MAX_LAYERS"
				:key="i"
				:class="[$style.panelBtn, { [$style.panelBtnActive]: currentLayer === i - 1 }]"
				@click="switchLayer(i - 1)"
			>
				レイヤー {{ i }}
			</button>
			<div :class="$style.panelLabel">レイヤー透明度: {{ Math.round(layerOpacity[currentLayer] * 100) }}%</div>
			<input
				type="range"
				min="0"
				max="100"
				:value="layerOpacity[currentLayer] * 100"
				:class="$style.opacitySlider"
				@input="(e: any) => setLayerOpacityValue(currentLayer, Number(e.target.value) / 100)"
			>
		</template>

		<!-- ダウンロードパネル -->
		<template v-if="activeToolPanel === 'download'">
			<button :class="$style.panelBtn" @click="downloadCanvas">
				<i class="ti ti-photo-down"></i> 全体を保存
			</button>
			<button :class="$style.panelBtn" @click="downloadMyStrokes">
				<i class="ti ti-user-down"></i> 自分のみ保存
			</button>
		</template>

		<!-- その他パネル（グループチャット固有） -->
		<template v-if="activeToolPanel === 'more'">
			<button :class="$style.panelBtn" @click="clearCanvas">
				<i class="ti ti-trash"></i> キャンバスをクリア
			</button>
			<button :class="$style.panelBtn" :disabled="!canRedo" @click="redo">
				<i class="ti ti-arrow-forward-up"></i> やり直す
			</button>
			<button :class="[$style.panelBtn, { [$style.panelBtnActive]: showWatermark }]" @click="showWatermark = !showWatermark">
				<i class="ti ti-photo-shield"></i> ウォーターマーク
			</button>
			<button :class="$style.panelBtn" @click="toggleFullscreen">
				<i :class="isFullscreen ? 'ti ti-minimize' : 'ti ti-maximize'"></i> {{ isFullscreen ? '全画面終了' : '全画面' }}
			</button>
			<button :class="$style.panelBtn" @click="resetZoom">
				<i class="ti ti-zoom-reset"></i> ズームリセット
			</button>
		</template>
	</div>

	<!-- キャンバス -->
	<div
		ref="canvasContainerEl"
		:class="$style.canvasContainer"
		@mousemove="draw"
		@mouseup="stopDrawing"
		@mouseleave="stopDrawing"
		@wheel.prevent="handleWheel"
		@touchstart="handleContainerTouchStart"
		@touchmove="handleContainerTouchMove"
		@touchend="handleContainerTouchEnd"
	>
		<!-- キャンバスローディング -->
		<div v-if="isCanvasLoading" :class="$style.loadingOverlay">
			<div :class="$style.loadingSpinner"></div>
		</div>

		<!-- デバッグパネル -->
		<div v-if="showDebugPanel" :class="$style.debugPanel">
			<div :class="$style.debugHeader">
				<h4>デバッグ情報</h4>
				<button :class="$style.debugCloseButton" @click="showDebugPanel = false">×</button>
			</div>
			<div :class="$style.debugContent">
				<div :class="$style.debugSection">
					<h5>📱 デバイス</h5>
					<p>DPR: {{ debugInfo.device.devicePixelRatio }}</p>
					<p>Type: {{ debugInfo.device.userAgent }}</p>
					<p>Touch: {{ debugInfo.device.touchDevice }}</p>
				</div>
				<div :class="$style.debugSection">
					<h5>📐 サイズ</h5>
					<p>物理: {{ debugInfo.sizes.physical }}</p>
					<p>CSS: {{ debugInfo.sizes.cssStyle }}</p>
					<p>表示: {{ debugInfo.sizes.actualDisplay }}</p>
					<p>論理: {{ debugInfo.sizes.logical }}</p>
					<p>描画域: {{ debugInfo.sizes.drawingArea }}</p>
				</div>
				<div :class="$style.debugSection">
					<h5>🎯 座標変換</h5>
					<p>スクリーン: {{ debugInfo.input.screen }}</p>
					<p>要素内: {{ debugInfo.input.element }}</p>
					<p>描画域: {{ debugInfo.input.drawing }}</p>
					<p>制限後: {{ debugInfo.input.clamped }}</p>
					<p>論理: {{ debugInfo.input.logical }}</p>
					<p>最終: {{ debugInfo.final.coordinates }}</p>
				</div>
				<div :class="$style.debugSection">
					<h5>⚖️ スケール・比率</h5>
					<p>描画スケール: {{ debugInfo.scales.drawingScale }}</p>
					<p>比率: {{ debugInfo.scales.aspectRatio }}</p>
					<p>オフセット: {{ debugInfo.scales.offset }}</p>
				</div>
				<div :class="$style.debugSection">
					<h5>🔄 変換</h5>
					<p>パン: {{ debugInfo.transform.panOffset }}</p>
					<p>ズーム: {{ debugInfo.transform.zoomLevel }}</p>
					<p>中心: {{ debugInfo.transform.zoomCenter }}</p>
					<p>基点: {{ debugInfo.transform.transformOrigin }}</p>
				</div>
				<div :class="$style.debugSection">
					<h5>👆 リアルタイム座標</h5>
					<p>状態: {{ realtimeCoords.isActive ? 'タッチ中' : '待機中' }}</p>
					<p>スクリーン: {{ realtimeCoords.screen }}</p>
					<p>キャンバス: {{ realtimeCoords.canvas }}</p>
				</div>
				<div :class="$style.debugSection">
					<h5>🕒 更新: {{ debugInfo.lastUpdate }}</h5>
				</div>
			</div>
		</div>

		<!-- 通信ログパネル -->
		<div v-if="showCommLogPanel" :class="$style.commLogPanel">
			<div :class="$style.commLogHeader">
				<h4>通信ログ</h4>
				<div :class="$style.commLogActions">
					<button :class="$style.commLogClearButton" @click="clearCommLog">クリア</button>
					<button :class="$style.commLogCloseButton" @click="showCommLogPanel = false">×</button>
				</div>
			</div>
			<div :class="$style.commLogContent">
				<div v-if="communicationLog.length === 0" :class="$style.commLogEmpty">
					通信ログがありません
				</div>
				<div
					v-for="(log, index) in communicationLog.slice().reverse()"
					:key="index"
					:class="[$style.commLogEntry, $style[`commLog${log.direction}`]]"
				>
					<div :class="$style.commLogTime">{{ formatTime(log.timestamp) }}</div>
					<div :class="$style.commLogType">
						<span :class="$style.commLogDirection">{{ log.direction === 'send' ? '送信' : '受信' }}</span>
						<span :class="$style.commLogEventType">{{ log.type }}</span>
					</div>
					<div :class="$style.commLogData">
						<pre>{{ formatLogData(log.data) }}</pre>
					</div>
				</div>
			</div>
		</div>
		<!-- CanvasEngine用メインキャンバス（paintchat式: 内部でレイヤー管理） -->
		<canvas
			ref="engineCanvasEl"
			:class="[$style.canvas, $style.layerCanvas]"
			:width="canvasWidth"
			:height="canvasHeight"
			:style="{
				width: displayWidth + 'px',
				height: displayHeight + 'px',
				transform: `translate(-50%, -50%) translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
				transformOrigin: 'center',
				transition: (isPanning || isZooming) ? 'none' : 'transform 0.2s ease',
				zIndex: MAX_LAYERS + 1,
				pointerEvents: 'auto'
			}"
			@mousedown="startDrawing"
			@contextmenu.prevent="onContextMenu"
			@touchstart.stop.prevent="handleContainerTouchStart"
			@touchmove.stop.prevent="handleContainerTouchMove"
			@touchend.stop.prevent="handleContainerTouchEnd"
		></canvas>

		<!-- ウォーターマーク（並べて表示） -->
		<div v-if="showWatermark" :class="$style.watermarkOverlay">
			<div :class="$style.watermarkTiles">
				<img
					v-for="i in 50"
					:key="i"
					:src="watermarkUrl"
					:class="$style.watermarkImage"
					alt="Oranski Nocturne"
				/>
			</div>
		</div>

		<!-- 他のユーザーのカーソル -->
		<div
			v-for="cursor in otherCursors"
			:key="cursor.userId"
			:class="$style.cursor"
			:style="{
				left: '50%',
				top: '50%',
				transform: `translate(-50%, -50%) translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel}) translate(${cursor.x - canvasWidth / 2}px, ${cursor.y - canvasHeight / 2}px)`,
				transformOrigin: 'center',
				color: getUserCursorColorLocal(cursor.userId)
			}"
		>
			<div :class="$style.cursorPointer"></div>
			<span
				:class="$style.cursorLabel"
				:style="{
					background: getUserCursorColorLocal(cursor.userId),
					color: getContrastColorLocal(getUserCursorColorLocal(cursor.userId))
				}"
			>
				{{ cursor.userName }}
			</span>
		</div>
	</div>

	<!-- チャットオーバーレイ（メッセージ通知バブル） -->
	<Transition name="chat-overlay">
		<div v-if="chatOverlay" :class="$style.chatOverlay">
			<div :class="$style.chatBubble">
				<MkAvatar :class="$style.chatAvatar" :user="chatOverlay.user" :size="24"/>
				<div :class="$style.chatText">{{ chatOverlay.text }}</div>
			</div>
		</div>
	</Transition>

	<!-- お絵描きチャットオーバーレイ -->
	<XDrawingChat
		ref="drawingChatRef"
		:connection="connection"
		:myUserId="$i.id"
		:myUserName="$i.name || $i.username"
		:roomId="props.roomId"
		:userId="props.userId"
	/>
</div>
</template>

<script lang="ts" setup>
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from 'vue';
import { defineAsyncComponent } from 'vue';
// 分離したコンポーネントをインポート
import DrawingToolbar from './room.drawing.toolbar.vue';
import DrawingDebugPanel from './room.drawing.debug.vue';
import XDrawingChat from './room.drawing.chat.vue';
// 分離したモジュールをインポート
import { screenToCanvasCoordinates, getActualDrawingArea } from './room.drawing.coordinates.js';
import {
	createCanvasEngine,
	getUserCursorColor,
	getContrastColor,
} from './room.drawing.canvas.js';
// 新規作成したComposableをインポート
import { useDrawingHandlers } from './room.drawing.handlers.js';
// useDrawingRenderはCanvasEngine方式に統合済み
import { useDrawingLayers } from './room.drawing.layers.js';
import { useDrawingNetwork } from './room.drawing.network.js';
// ユーティリティ関数をインポート
import {
	applyHandShakeCorrection as applyHandShakeCorrectionUtil,
	calculatePressure as calculatePressureUtil,
	simplifyPath as simplifyPathUtil,
	smoothPoints as smoothPointsUtil,
	getAccurateCoordinates as getAccurateCoordinatesUtil,
	formatTime as formatTimeUtil,
	formatLogData as formatLogDataUtil,
} from './room.drawing.utils.js';
// キャンバスエリアコンポーネントをインポート
import DrawingCanvasArea from './room.drawing.canvas-area.vue';
// 分離したComposableをインポート
import {
	useDrawing,
	useDrawingConnection,
	useCanvasOperations,
	useZoomPan,
	useUndoRedo,
	useDrawingUtils,
	useToolState,
	useColorHistory,
} from './room.drawing.composables.js';
import {
	useGestures,
	useKeyboard,
	useWheel,
} from './room.drawing.gestures.js';
import type {
	ToolType,
	Point,
	PressurePoint,
	StrokeData,
	DrawingTraceLog,
	CommunicationLog,
	CanvasSize,
	DebugInfo,
	RealtimeCoords,
	CorrectionLevel,
	CanvasEngine,
} from './room.drawing.types.js';
import MkAvatar from '@/components/global/MkAvatar.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';
import { ensureSignin } from '@/i.js';
import { useStream } from '@/stream.js';

const props = defineProps<{
	roomId?: string;
	userId?: string;
}>();

const $i = ensureSignin();

// 描画ID (roomId または userId-$i.id のいずれかを使用)
const drawingId = computed(() => {
	if (props.roomId) {
		return props.roomId;
	} else if (props.userId) {
		// 1対1チャットの場合は、小さいユーザーIDを先に置いて一意にする
		const userIds = [props.userId, $i.id].sort();
		return `user-${userIds[0]}-${userIds[1]}`;
	} else {
		throw new Error('roomId or userId is required');
	}
});

// paintchat式CanvasEngineインスタンス
const canvasEngine = ref<CanvasEngine | null>(null);
const isCanvasLoading = ref(true);
// CanvasEngine用のcanvas要素
const engineCanvasEl = ref<HTMLCanvasElement>();

// キャンバス関連
const canvasEl = ref<HTMLCanvasElement>();
const canvasContainerEl = ref<HTMLDivElement>();
const canvasWidth = ref(1600); // 1600x1200固定（paintchat準拠）
const canvasHeight = ref(1200);
const displayWidth = ref(1600); // 表示サイズ
const displayHeight = ref(1200);


// キャンバスサイズプリセット
const canvasSizePresets = [
	{ name: '標準 (800×600)', width: 800, height: 600 },
	{ name: '正方形小 (600×600)', width: 600, height: 600 },
	{ name: '正方形大 (1000×1000)', width: 1000, height: 1000 },
	{ name: 'HD (1280×720)', width: 1280, height: 720 },
	{ name: 'Full HD (1920×1080)', width: 1920, height: 1080 },
	{ name: 'A4縦 (595×842)', width: 595, height: 842 },
	{ name: 'A4横 (842×595)', width: 842, height: 595 },
];

// 軌跡記録用のログ
const drawingTraceLog = ref<Array<{
	timestamp: number;
	type: 'touchstart' | 'touchmove' | 'touchend' | 'mousedown' | 'mousemove' | 'mouseup';
	screenX: number;
	screenY: number;
	canvasX: number;
	canvasY: number;
	tool: string;
	color: string;
	strokeWidth: number;
	zoomLevel: number;
	panOffset: { x: number; y: number };
}>>([]);

// ウォーターマーク設定
const showWatermark = ref(false);
const watermarkUrl = 'https://noc.ski/files/5f672682-73ab-484f-adb8-37e7e4bc0a4c';

// 通信ログ用
const showCommLogPanel = ref(false);
const communicationLog = ref<Array<{
	timestamp: number;
	direction: 'send' | 'receive';
	type: string;
	data: any;
}>>([]);
const MAX_COMM_LOG_ENTRIES = 100;

// 描画状態
const isDrawing = ref(false);
const currentTool = ref<'pen' | 'eraser' | 'eyedropper' | 'move'>('pen');
const currentColor = ref('#000000');
const currentColorIndex = ref(0); // 現在選択中のカラーパレットのインデックス
const currentOpacity = ref(1);
const strokeWidth = ref(2);

// ツール別の線の太さを記憶
const toolStrokeWidths = ref({
	pen: 2,
	eraser: 10,
});

// 全画面モード
const isFullscreen = ref(false);

// タッチデバイス検出
const isTouchDevice = ref(false);

// ツールバー開閉状態（モバイル専用）
const isToolbarOpen = ref(false);

// デバッグ用状態
let debugLogCount = 0;
const showDebugPanel = ref(false);
const showMoreMenu = ref(false);
const activeToolPanel = ref<'color' | 'width' | 'layer' | 'download' | 'more' | null>(null);
const drawingChatRef = ref<InstanceType<typeof XDrawingChat> | null>(null);

function toggleToolPanel(panel: 'color' | 'width' | 'layer' | 'download' | 'more') {
	activeToolPanel.value = activeToolPanel.value === panel ? null : panel;
}

// チャットオーバーレイの開閉
function toggleDrawingChat() {
	if (drawingChatRef.value?.isOpen) {
		drawingChatRef.value.closeChat();
	} else {
		drawingChatRef.value?.openChat();
	}
}

// 移動（パン）ツール
const isMoveMode = ref(false);
function toggleMoveMode() {
	isMoveMode.value = !isMoveMode.value;
	if (isMoveMode.value) {
		currentTool.value = 'move' as any;
		if (engineCanvasEl.value) engineCanvasEl.value.style.cursor = 'grab';
	} else {
		currentTool.value = 'pen';
		if (engineCanvasEl.value) engineCanvasEl.value.style.cursor = 'crosshair';
	}
	saveUserSettings();
}

// 筆圧ON/OFF
const pressureEnabled = ref(true);
function togglePressure() {
	pressureEnabled.value = !pressureEnabled.value;
	if (canvasEngine.value) {
		canvasEngine.value.setPressureEnabled(pressureEnabled.value);
	}
}

// レイヤー透明度変更
function setLayerOpacityValue(layer: number, opacity: number) {
	const newOpacities = [...layerOpacity.value];
	newOpacities[layer] = opacity;
	layerOpacity.value = newOpacities;
	if (canvasEngine.value) {
		canvasEngine.value.setLayerOpacity(layer, opacity);
	}
	saveUserSettings();
}

// iOS判定
function isIOS(): boolean {
	return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// 画像ダウンロード（iOS: Web Share API共有シート、その他: data URL）
function downloadImage(dataUrl: string, filename: string) {
	if (isIOS() && navigator.share != null) {
		// iOS: Web Share APIでPhotosへの保存を含む共有シートを表示
		const byteString = atob(dataUrl.split(',')[1]);
		const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
		const ab = new ArrayBuffer(byteString.length);
		const ia = new Uint8Array(ab);
		for (let i = 0; i < byteString.length; i++) {
			ia[i] = byteString.charCodeAt(i);
		}
		const blob = new Blob([ab], { type: mimeString });
		const file = new File([blob], filename, { type: 'image/png' });
		navigator.share({ files: [file] }).catch(() => {
			// 共有キャンセル時はdata URLフォールバック
			downloadViaLink(dataUrl, filename);
		});
	} else {
		downloadViaLink(dataUrl, filename);
	}
}

function downloadViaLink(dataUrl: string, filename: string) {
	const link = window.document.createElement('a');
	link.href = dataUrl;
	link.download = filename;
	window.document.body.appendChild(link);
	link.click();
	window.document.body.removeChild(link);
}

// 自分のストロークのみダウンロード
function downloadMyStrokes() {
	if (!canvasEngine.value) return;
	const dataUrl = canvasEngine.value.toMyStrokesDataURL();
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
	downloadImage(dataUrl, `my-drawing_${timestamp}.png`);
}

// カラーヒストリー（最近使った色、最大10色、localStorage永続化）
const { colorHistory, addColor: addColorToHistory } = useColorHistory();

const debugInfo = ref<DebugInfo>({
	device: {},
	sizes: {},
	input: {},
	scales: {},
	transform: {},
	final: {},
	lastUpdate: '',
});

// リアルタイム座標表示用
const realtimeCoords = ref({
	screen: '(0, 0)',
	canvas: '(0, 0)',
	isActive: false,
});

// パン（移動）状態
const isPanning = ref(false);
const panOffset = ref({ x: 0, y: 0 });
const panStart = ref({ x: 0, y: 0 });
const lastTouchDistance = ref(0);
const isSpaceKeyPressed = ref(false); // スペースキー押下状態
const isPanningWithSpace = ref(false); // スペースキーでのパン中

// ズーム（拡大縮小）状態
const zoomLevel = ref(1);
const zoomCenter = ref({ x: 0, y: 0 });
// ズーム範囲: paintchat互換（0.25x〜12x）
const minZoom = 0.25;
const maxZoom = 12;
const isZooming = ref(false);

// ジェスチャー状態管理
const gestureState = ref<'none' | 'pan' | 'zoom' | 'hybrid'>('none');
const initialDistance = ref(0);
const distanceHistory = ref<number[]>([]);
const panThreshold = 5; // パン開始の最小移動距離
const zoomThreshold = 15; // ズーム開始の最小距離変化

// アンドゥ用ダブルタップ検出
const lastTwoFingerTap = ref(0);
const twoFingerTapTimeout = 500; // ダブルタップの間隔（ms）
const twoFingerTapStartPos = ref<Point | null>(null);
const tapMoveThreshold = 20; // タップ判定の最大移動距離（ピクセル）

// 手ブレ補正設定
const handShakeCorrection = {
	enabled: ref(true),
	level: ref(3), // 補正レベル 1-5 (1:最弱, 5:最強)
	pressureSimulation: ref(true), // 筆圧シミュレーション
	stabilization: ref(true), // 手ぶれ補正
};

// 手ブレ補正レベル設定
const correctionLevels = [
	{ level: 1, name: '最弱', factor: 0.3, minDistance: 0.5, velocitySmoothing: 0.3 },
	{ level: 2, name: '弱', factor: 0.5, minDistance: 1, velocitySmoothing: 0.5 },
	{ level: 3, name: '標準', factor: 0.7, minDistance: 1.5, velocitySmoothing: 0.7 },
	{ level: 4, name: '強', factor: 0.85, minDistance: 2, velocitySmoothing: 0.85 },
	{ level: 5, name: '最強', factor: 0.95, minDistance: 3, velocitySmoothing: 0.95 },
];

// 現在の補正レベル設定を取得
const getCurrentCorrectionSettings = () => {
	return correctionLevels[handShakeCorrection.level.value - 1];
};

// 手ブレ補正用の状態
let smoothedPoint = { x: 0, y: 0 };
let lastPoint = { x: 0, y: 0 };
let velocity = 0;
let lastTime = 0;
const velocityHistory: number[] = [];
const pointBuffer: Array<{ x: number; y: number; time: number }> = [];

// リアルタイム描画同期用
let lastProgressSent = 0;
const progressSendInterval = 50; // 50ms間隔で進行状況を送信

// 座標計算精度向上用
let canvasRect = ref<DOMRect | null>(null);
let resizeObserver: ResizeObserver | null = null;

// カラーパレット（paintchat互換30色パレット）
const colors = ref([
	'#000000', '#3b3b3b', '#808080', '#c8c8c8', '#ffffff',
	'#c0392b', '#e74c3c', '#e67e22', '#f39c12', '#f1c40f',
	'#27ae60', '#2ecc71', '#16a085', '#2980b9', '#3498db',
	'#8e44ad', '#9b59b6', '#e91e8f', '#fd79a8', '#fdcb6e',
	'#fab1a0', '#ffeaa7', '#dfe6e9', '#a29bfe', '#74b9ff',
	'#55efc4', '#81ecec', '#d4a574', '#8d6e63', '#4a3728',
]);

// 透明度レベル
const opacityLevels = [0.2, 0.4, 0.6, 0.8, 1.0];

// 線の太さレベル（paintchat互換、最大200px）
const strokeWidthLevels = [1, 2, 3, 5, 8, 12, 20, 40, 80, 120, 200];

// パフォーマンス管理
const maxUndoHistory = 20; // アンドゥ履歴の最大数
const strokeHistory = ref<Array<any>>([]); // ストローク履歴
const rasterizeThreshold = 50; // ラスタライズを実行するストローク数

// Undo/Redo管理
/**
 * Undo/Redoスタック
 *
 * 【仕様】
 * - undoStack: 使用しない（レイヤーごとのストローク履歴で管理）
 * - redoStack: ユーザーごとのUndoで削除したストロークを保存
 * - canUndo: 現在のレイヤーに自分のストロークがあるかチェック
 * - canRedo: redoスタックに自分のストロークがあるかチェック
 *
 * 【ユーザーごとの履歴】
 * - Undoは自分のストロークのみを削除
 * - Redoは自分が削除したストロークのみを復元
 */
const undoStack = ref<Array<any>>([]); // 元に戻す用のスタック（使用しない）
const redoStack = ref<Array<any>>([]); // やり直す用のスタック
// CanvasEngine経由: ストローク履歴があればUndo可能
// CanvasEngineにはcanUndo()がないため、strokeHistoryの長さで判定
const canUndo = computed(() => strokeHistory.value.length > 0);
const canRedo = computed(() => undoneStrokes.value.length > 0 || redoStack.value.length > 0);

// レイヤー管理（3レイヤー）
const MAX_LAYERS = 3;
const currentLayer = ref(0); // 現在のレイヤー (0, 1, 2)
const layerVisible = ref<Array<boolean>>([true, true, true]); // 各レイヤーの表示状態
const layerOpacity = ref<Array<number>>([1.0, 1.0, 1.0]); // 各レイヤーの透明度

function clampLayerIndex(layer: unknown): number {
	const numeric = typeof layer === 'number' && Number.isFinite(layer) ? Math.floor(layer) : 0;
	return Math.min(Math.max(numeric, 0), MAX_LAYERS - 1);
}


function normalizeStrokeForHistory(stroke: any) {
	const layer = clampLayerIndex(stroke?.layer);
	const rawPoints = Array.isArray(stroke?.points) ? stroke.points : [];
	const points = rawPoints
		.filter((point: any) => point && typeof point.x === 'number' && typeof point.y === 'number')
		.map((point: any) => ({
			x: point.x,
			y: point.y,
			pressure: typeof point.pressure === 'number' ? point.pressure : undefined,
		}));

	if (points.length === 0) return null;

	const strokeWidth = typeof stroke?.strokeWidth === 'number' && Number.isFinite(stroke.strokeWidth)
		? Math.max(1, Math.min(100, stroke.strokeWidth))
		: 1;
	const opacity = typeof stroke?.opacity === 'number' && Number.isFinite(stroke.opacity)
		? Math.min(Math.max(stroke.opacity, 0), 1)
		: 1;

	return {
		id: typeof stroke?.id === 'string' ? stroke.id : undefined,
		userId: stroke?.userId ?? null,
		userName: stroke?.userName ?? null,
		tool: ['pen', 'eraser', 'eyedropper'].includes(stroke?.tool) ? stroke.tool : 'pen',
		color: typeof stroke?.color === 'string' ? stroke.color : '#000000',
		strokeWidth,
		opacity,
		timestamp: typeof stroke?.timestamp === 'number' ? stroke.timestamp : Date.now(),
		layer,
		points,
	};
}

// ストロークの正規化のみ行う（旧レイヤーcanvas描画は削除済み）
function renderStrokeOnLayer(
	stroke: any,
	options: { skipIfSelf?: boolean; updateHistory?: boolean; suppressRender?: boolean } = {},
) {
	const normalized = normalizeStrokeForHistory(stroke);
	if (!normalized) return null;

	if (options.skipIfSelf && normalized.userId && normalized.userId === $i.id) {
		return null;
	}

	return normalized;
}

// WebSocket接続
const connection = ref<any>();

// 他のユーザーのカーソル
const otherCursors = ref<Array<{
	userId: string;
	userName: string;
	x: number;
	y: number;
	color: string;
}>>([]);


// チャットオーバーレイ
const chatOverlay = ref<{
	user: any;
	text: string;
} | null>(null);

// 現在の描画パス
let currentPath: PressurePoint[] = [];

// 設定保存用デバウンスタイマー
let saveSettingsTimer: number | null = null;

// ユーザー設定を読み込む
async function loadUserSettings() {
	try {
		const settings = await misskeyApi('drawing/settings/user/get', {
			canvasId: drawingId.value,
		});

		if (settings) {
			// 移動ツールの復元
			const tool = settings.currentTool as string;
			if (tool === 'move') {
				isMoveMode.value = true;
				currentTool.value = 'move';
			} else {
				currentTool.value = tool as any;
				isMoveMode.value = false;
			}
			currentColor.value = settings.currentColor;
			currentOpacity.value = settings.currentOpacity;
			strokeWidth.value = settings.strokeWidth;
			currentLayer.value = settings.currentLayer;
			layerVisible.value = settings.layerVisible;
			layerOpacity.value = settings.layerOpacity;
			zoomLevel.value = settings.zoomLevel;
			panOffset.value.x = settings.panOffsetX;
			panOffset.value.y = settings.panOffsetY;
			// カラーパレットを復元（保存されている場合）
			if ((settings as any).colors && Array.isArray((settings as any).colors)) {
				colors.value = (settings as any).colors;
			}
			// ツール別太さを復元
			if ((settings as any).penStrokeWidth) {
				toolStrokeWidths.value.pen = (settings as any).penStrokeWidth;
			}
			if ((settings as any).eraserStrokeWidth) {
				toolStrokeWidths.value.eraser = (settings as any).eraserStrokeWidth;
			}
			// 現在のツールの太さを復元
			if (currentTool.value === 'pen' || currentTool.value === 'eraser') {
				strokeWidth.value = toolStrokeWidths.value[currentTool.value as 'pen' | 'eraser'];
			}
		}
	} catch (error) {
		console.error('❌ [SETTINGS] Failed to load user settings:', error);
	}
}

// ルーム設定を読み込む
async function loadRoomSettings() {
	try {
		const settings = await misskeyApi('drawing/settings/room/get', {
			canvasId: drawingId.value,
		});

		if (settings) {
			// キャンバスサイズは1600x1200固定（paintchat準拠）。サーバー値で上書きしない
			// canvasWidth.value = settings.canvasWidth;
			// canvasHeight.value = settings.canvasHeight;
		}
	} catch (error) {
		console.error('❌ [SETTINGS] Failed to load room settings:', error);
	}
}

// ルーム設定を保存する
async function saveRoomSettings() {
	try {
		await misskeyApi('drawing/settings/room/update', {
			canvasId: drawingId.value,
			canvasWidth: canvasWidth.value,
			canvasHeight: canvasHeight.value,
		});
	} catch (error) {
		console.error('❌ [SETTINGS] Failed to save room settings:', error);
	}
}

// ユーザー設定を保存する（デバウンス付き）
// 前回保存した設定値（差分検出用）
let lastSavedSettings: Record<string, any> = {};

function saveUserSettings() {
	if (saveSettingsTimer !== null) {
		window.clearTimeout(saveSettingsTimer);
	}

	saveSettingsTimer = window.setTimeout(async () => {
		try {
			// 現在の全設定値
			const current: Record<string, any> = {
				currentTool: currentTool.value,
				currentColor: currentColor.value,
				currentOpacity: currentOpacity.value,
				strokeWidth: strokeWidth.value,
				currentLayer: currentLayer.value,
				layerVisible: JSON.stringify(layerVisible.value),
				layerOpacity: JSON.stringify(layerOpacity.value),
				zoomLevel: Math.max(0.25, Math.min(12.0, zoomLevel.value)),
				panOffsetX: panOffset.value.x,
				panOffsetY: panOffset.value.y,
				penStrokeWidth: toolStrokeWidths.value.pen,
				eraserStrokeWidth: toolStrokeWidths.value.eraser,
				pressureEnabled: pressureEnabled.value,
				colorHistory: JSON.stringify(colorHistory.value),
			};

			// 差分検出（変更があったフィールドのみ送信、通信量削減）
			const params: Record<string, any> = { canvasId: drawingId.value };
			let hasChanges = false;
			for (const [key, value] of Object.entries(current)) {
				if (lastSavedSettings[key] !== value) {
					// JSON文字列化されたフィールドは元の値で送信
					if (key === 'layerVisible') params[key] = layerVisible.value;
					else if (key === 'layerOpacity') params[key] = layerOpacity.value;
					else if (key === 'colorHistory') params[key] = colorHistory.value;
					else params[key] = value;
					hasChanges = true;
				}
			}

			if (!hasChanges) return;

			await misskeyApi('drawing/settings/user/update', params as any);
			lastSavedSettings = { ...current };
		} catch (error) {
			console.error('❌ [SETTINGS] Failed to save user settings:', error);
		}
	}, 1000); // 1秒のデバウンス
}

onMounted(async () => {
	// ルーム設定を読み込む（キャンバスサイズ）
	// テンプレートのバインディングが適用される前に読み込む必要がある
	await loadRoomSettings();

	// 次のフレームで実行（テンプレートのバインディングが適用された後）
	await nextTick();

	// コンテナサイズに合わせてdisplayサイズを更新
	updateDisplaySize();

	// canvasElにengineCanvasElを設定（イベントリスナーやカーソルスタイル変更用）
	canvasEl.value = engineCanvasEl.value;

	// paintchat式CanvasEngineの初期化（engineCanvasElはDPR非適用の論理サイズcanvas）
	if (engineCanvasEl.value) {
		const engine = createCanvasEngine($i.id);
		engine.init(engineCanvasEl.value);
		canvasEngine.value = engine;
	}

	// タッチデバイス検出
	isTouchDevice.value = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

	if (isTouchDevice.value && strokeWidth.value === 2) {
		strokeWidth.value = 4;
		toolStrokeWidths.value.pen = 4;
	}

	// WebSocket接続
	connectToChatRoomChannel();

	// データ読み込み（バックグラウンド、ローディングHUDなし）
	const [, userSettings] = await Promise.all([
		loadCanvasData(),
		loadUserSettings(),
	]);

	// CanvasEngineにユーザー設定を同期
	if (canvasEngine.value) {
		const currentWidth = (currentTool.value === 'pen' || currentTool.value === 'eraser')
			? toolStrokeWidths.value[currentTool.value as 'pen' | 'eraser']
			: strokeWidth.value;
		strokeWidth.value = currentWidth;

		canvasEngine.value.setState({
			currentTool: currentTool.value as any,
			currentColor: currentColor.value,
			currentWidth: currentWidth,
			currentOpacity: currentOpacity.value,
		});
		canvasEngine.value.setCurrentLayer(currentLayer.value);

		if (isMoveMode.value && engineCanvasEl.value) {
			engineCanvasEl.value.style.cursor = 'grab';
		}
		canvasEngine.value.setPressureEnabled(pressureEnabled.value);
		for (let i = 0; i < layerOpacity.value.length; i++) {
			canvasEngine.value.setLayerOpacity(i, layerOpacity.value[i]);
		}
	}

	// ローディング完了（CanvasEngine初期化 + データ読み込み + 設定同期完了）
	isCanvasLoading.value = false;

	// 全画面モード用のイベントリスナー
	window.document.addEventListener('fullscreenchange', handleFullscreenChange);

	// キャンバスサイズ変更監視でより正確な座標計算
	if (canvasEl.value && 'ResizeObserver' in window) {
		canvasRect.value = canvasEl.value.getBoundingClientRect();
		resizeObserver = new ResizeObserver(() => {
			if (canvasEl.value) {
				const rect = canvasEl.value.getBoundingClientRect();
				canvasRect.value = rect;
				// displayWidth/displayHeightは固定値を維持し、ResizeObserverでは更新しない
				// transformによるサイズ変化を拾わないようにする
			}
		});
		resizeObserver.observe(canvasEl.value);
	}

	// デフォルトカーソルを設定
	if (canvasEl.value) {
		canvasEl.value.style.cursor = 'crosshair';
	}

	// キーボードショートカット
	const handleKeyDown = (e: KeyboardEvent) => {
		const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
		const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

		// スペースキー: パンモード開始
		if (e.key === ' ' && !e.repeat && !isTouchDevice.value) {
			e.preventDefault();
			isSpaceKeyPressed.value = true;
			if (canvasEl.value) {
				canvasEl.value.style.cursor = 'grab';
			}
		} else if (e.key === 'p' || e.key === 'P') { // P: ペンツール
			e.preventDefault();
			setTool('pen');
		} else if (e.key === 'e' || e.key === 'E') { // E: 消しゴムツール
			e.preventDefault();
			setTool('eraser');
		} else if (e.key === 'i' || e.key === 'I') { // I: スポイトツール
			e.preventDefault();
			setTool('eyedropper');
		} else if (ctrlKey && e.key === 'z' && !e.shiftKey) { // Ctrl+Z / Cmd+Z: Undo
			e.preventDefault();
			undo();
		} else if (ctrlKey && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { // Ctrl+Y / Cmd+Y: Redo
			e.preventDefault();
			redo();
		} else if (ctrlKey && e.key === '0') { // Ctrl+0 / Cmd+0: ズームをリセット
			e.preventDefault();
			resetZoom();
		}
	};

	const handleKeyUp = (e: KeyboardEvent) => {
		// スペースキー: パンモード終了
		if (e.key === ' ' && !isTouchDevice.value) {
			isSpaceKeyPressed.value = false;
			isPanningWithSpace.value = false;
			if (canvasEl.value) {
				canvasEl.value.style.cursor = 'crosshair';
			}
		}
	};

	// マウスホイールでズーム（PC版のみ）
	const handleWheel = (e: WheelEvent) => {
		if (isTouchDevice.value) return;

		const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
		const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

		// Ctrl/Cmdキーを押しながらホイール操作でズーム
		if (ctrlKey) {
			e.preventDefault();

			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			const newZoom = Math.max(minZoom, Math.min(maxZoom, zoomLevel.value + delta));

			if (newZoom !== zoomLevel.value) {
				// マウス位置を中心にズーム
				// 現在のズーム前の論理座標を取得
				const beforeZoomCoords = screenToCanvasCoordinates(
					e.clientX,
					e.clientY,
					engineCanvasEl.value || null,
					canvasWidth.value,
					canvasHeight.value,
				);

				// ズームレベルを更新
				const oldZoom = zoomLevel.value;
				zoomLevel.value = newZoom;

				// ズーム後の論理座標を取得
				const afterZoomCoords = screenToCanvasCoordinates(
					e.clientX,
					e.clientY,
					engineCanvasEl.value || null,
					canvasWidth.value,
					canvasHeight.value,
				);

				// マウス位置が変わらないようにパンオフセットを調整
				const offsetDeltaX = afterZoomCoords.x - beforeZoomCoords.x;
				const offsetDeltaY = afterZoomCoords.y - beforeZoomCoords.y;

				panOffset.value = {
					x: panOffset.value.x - offsetDeltaX,
					y: panOffset.value.y - offsetDeltaY,
				};
			}
		}
	};

	window.document.addEventListener('keydown', handleKeyDown);
	window.document.addEventListener('keyup', handleKeyUp);
	if (canvasEl.value) {
		canvasEl.value.addEventListener('wheel', handleWheel, { passive: false });
	}

	// ウィンドウリサイズ時にdisplayサイズを更新
	window.addEventListener('resize', updateDisplaySize);

	// 定期的なパフォーマンス監視（30秒間隔）
	const performanceMonitor = window.setInterval(() => {
		monitorPerformance();
	}, 30000);

	// コンポーネント終了時にクリア
	onBeforeUnmount(() => {
		window.clearInterval(performanceMonitor);
		window.document.removeEventListener('keydown', handleKeyDown);
		window.document.removeEventListener('keyup', handleKeyUp);
		window.removeEventListener('resize', updateDisplaySize);
		if (canvasEl.value) {
			canvasEl.value.removeEventListener('wheel', handleWheel);
		}
	});
});

onBeforeUnmount(() => {
	// CanvasEngineの破棄
	if (canvasEngine.value) {
		canvasEngine.value.dispose();
		canvasEngine.value = null;
	}

	if (connection.value) {
		connection.value.dispose();
	}

	// カーソルタイマーをクリア
	cursorTimers.forEach((timer) => {
		window.clearTimeout(timer);
	});
	cursorTimers.clear();

	// 全画面モード用のイベントリスナーを削除
	window.document.removeEventListener('fullscreenchange', handleFullscreenChange);

	// ResizeObserver のクリーンアップ
	if (resizeObserver) {
		resizeObserver.disconnect();
		resizeObserver = null;
	}
});

// WebSocket接続（統合：お絵かき＋チャット）
function connectToChatRoomChannel() {
	const stream = useStream();

	// ユーザー間チャットかルームチャットかで使用するチャンネルを切り替え
	if (props.userId) {
		// 1対1チャットの場合はchatUserチャンネルを使用
		connection.value = stream.useChannel('chatUser', {
			otherId: props.userId,
		});
	} else {
		// ルームチャットの場合はchatRoomチャンネルを使用
		connection.value = stream.useChannel('chatRoom', {
			roomId: drawingId.value,
		});
	}

	// お絵かき関連イベント（CanvasEngine経由で描画）
	connection.value.on('drawingStroke', (data: any) => {
		recordCommLog('receive', 'drawingStroke', data);
		if (data.userId === $i.id) return;
		if (canvasEngine.value) {
			// リモートストロークをCanvasEngineに渡して描画
			const remoteStroke = {
				id: data.id || `remote-${Date.now()}`,
				participantId: data.userId,
				userId: data.userId,
				userName: data.userName || '',
				points: (data.points || []).map((p: any) => ({
					x: p.x, y: p.y, pressure: p.pressure ?? 1.0,
				})),
				color: data.color,
				width: data.strokeWidth,
				strokeWidth: data.strokeWidth,
				opacity: data.opacity,
				tool: data.tool,
				layer: data.layer ?? 0,
				timestamp: Date.now(),
			};
			canvasEngine.value.drawRemoteStroke(remoteStroke as any);
		}
	});

	connection.value.on('drawingProgress', (data: any) => {
		recordCommLog('receive', 'drawingProgress', data);
		if (data.userId === $i.id) return;
		if (canvasEngine.value) {
			const points = (data.points || []).map((p: any) => ({
				x: p.x, y: p.y, pressure: p.pressure ?? 1.0,
			}));
			canvasEngine.value.drawRemoteProgress(data.userId, points);
		}
	});

	connection.value.on('cursorMove', (data: any) => {
		recordCommLog('receive', 'cursorMove', data);
		updateOtherCursor(data);
	});

	connection.value.on('clearCanvas', () => {
		recordCommLog('receive', 'clearCanvas', {});
		if (canvasEngine.value) {
			canvasEngine.value.clear();
		}
		clearCanvasLocal();
	});

	connection.value.on('undoStroke', (data: any) => {
		recordCommLog('receive', 'undoStroke', data);
		if (canvasEngine.value && data.strokeId) {
			canvasEngine.value.applyRemoteUndo(data.strokeId);
		}
	});

	connection.value.on('redoStroke', (data: any) => {
		recordCommLog('receive', 'redoStroke', data);
		// Redo is handled via drawingStroke event from CanvasEngine
	});

	connection.value.on('canvasSizeChange', (data: any) => {
		recordCommLog('receive', 'canvasSizeChange', data);
		handleRemoteCanvasSizeChange(data);
	});

	// チャットオーバーレイ用
	connection.value.on('message', (message: any) => {
		showChatOverlay(message);
		// チャットオーバーレイにメッセージを追加（自分のメッセージも含む）
		if (drawingChatRef.value) {
			drawingChatRef.value.addMessage({
				id: message.id || `msg-${Date.now()}`,
				userName: message.fromUser?.name || message.fromUser?.username
					|| (message.fromUserId === $i.id ? ($i.name || $i.username) : ''),
				content: message.text || '',
				createdAt: message.createdAt || new Date().toISOString(),
				fromUserId: message.fromUserId,
			});
		}
	});
}

// ツール設定
function setTool(tool: 'pen' | 'eraser' | 'eyedropper') {
	// 移動モードを解除
	if (isMoveMode.value) {
		isMoveMode.value = false;
		if (engineCanvasEl.value) engineCanvasEl.value.style.cursor = 'crosshair';
	}

	// ツール切り替え時に現在の描画を強制終了
	if (isDrawing.value) {
		stopDrawing();
	}

	// 現在のツールの線の太さを保存
	if (currentTool.value === 'pen' || currentTool.value === 'eraser') {
		toolStrokeWidths.value[currentTool.value] = strokeWidth.value;
	}

	// 新しいツールに切り替え
	currentTool.value = tool;

	// 新しいツールの線の太さを復元
	if (tool === 'pen' || tool === 'eraser') {
		strokeWidth.value = toolStrokeWidths.value[tool];
	}

	// CanvasEngineに状態を同期
	if (canvasEngine.value) {
		canvasEngine.value.setState({ currentTool: tool as any, currentWidth: strokeWidth.value });
	}

	saveUserSettings();
}

function setColor(color: string, index?: number) {
	currentColor.value = color;
	if (index !== undefined) {
		currentColorIndex.value = index;
	}
	if (currentTool.value === 'eraser') {
		currentTool.value = 'pen';
	}

	// CanvasEngineに色を同期
	if (canvasEngine.value) {
		canvasEngine.value.setState({ currentColor: color, currentTool: currentTool.value as any });
	}

	saveUserSettings();
}

// カラーピッカーを開く
function openColorPicker() {
	// Promiseを使ってokイベントを受け取る
	return new Promise<string | null>((resolve) => {
		const { dispose } = os.popup(
			defineAsyncComponent(() => import('@/components/MkColorPickerDialog.vue')),
			{
				currentColor: currentColor.value,
			},
			{
				ok: (color: string) => {
					resolve(color);
					dispose();
				},
				closed: () => {
					resolve(null);
					dispose();
				},
			},
		);
	}).then((colorValue) => {
		if (colorValue) {
			// 現在選択中のカラーパレットの色を更新
			colors.value[currentColorIndex.value] = colorValue;
			// 選択した色を現在の色として設定
			setColor(colorValue, currentColorIndex.value);
		}
	});
}

function setOpacity(opacity: number) {
	currentOpacity.value = opacity;
	if (canvasEngine.value) {
		canvasEngine.value.setState({ currentOpacity: opacity });
	}
	saveUserSettings();
}

function setStrokeWidth(width: number) {
	strokeWidth.value = width;
	if (currentTool.value === 'pen' || currentTool.value === 'eraser') {
		toolStrokeWidths.value[currentTool.value] = width;
	}
	if (canvasEngine.value) {
		canvasEngine.value.setState({ currentWidth: width });
	}
	saveUserSettings();
}

// 右クリック消しゴム状態
let temporaryEraserMode = false;
let originalToolBeforeEraser: string = 'pen';

// 右クリックメニュー抑制
function onContextMenu(e: Event) {
	e.preventDefault();
}

// 描画開始（CanvasEngine経由）
function startDrawing(event: MouseEvent | TouchEvent) {
	if (!canvasEngine.value) return;

	// 移動モード中はパンとして処理（マウス・タッチ両対応）
	if (isMoveMode.value) {
		isPanningWithSpace.value = true;
		if (event instanceof MouseEvent) {
			panStart.value = { x: event.clientX, y: event.clientY };
		} else if (event.touches.length > 0) {
			panStart.value = { x: event.touches[0].clientX, y: event.touches[0].clientY };
		}
		if (engineCanvasEl.value) engineCanvasEl.value.style.cursor = 'grabbing';
		return;
	}

	// 右クリック（button=2）で一時消しゴムモード
	if (event instanceof MouseEvent && event.button === 2) {
		temporaryEraserMode = true;
		originalToolBeforeEraser = currentTool.value;
		canvasEngine.value.setState({ currentTool: 'eraser' as any });
		event.preventDefault();
	}

	// スペースキーが押されている場合はパンモード
	if (isSpaceKeyPressed.value && event instanceof MouseEvent) {
		isPanningWithSpace.value = true;
		panStart.value = { x: event.clientX, y: event.clientY };
		if (canvasEl.value) {
			canvasEl.value.style.cursor = 'grabbing';
		}
		return;
	}

	// マウス補正状態をリセット
	lastTime = 0;
	velocityHistory.length = 0;
	pointBuffer.length = 0;

	const point = getEventPoint(event);
	const pressure = calculatePressure();

	if (currentTool.value === 'eyedropper') {
		eyedropColor(point);
		return;
	}

	// CanvasEngineの描画状態を同期
	canvasEngine.value.setState({
		currentTool: currentTool.value as any,
		currentColor: currentColor.value,
		currentWidth: strokeWidth.value,
		currentOpacity: currentOpacity.value,
	});
	canvasEngine.value.setCurrentLayer(currentLayer.value);

	// ストローク開始を遅延（paintchat同様: 2本指パンへの切替時にドットが描かれるのを防止）
	// draw()で一定距離以上動いたら実際にbeginStrokeする
	pendingStrokeStart = { x: point.x, y: point.y, pressure };
	strokeStarted = false;
	isDrawing.value = true;
	currentPath = [];
}

// ストローク遅延書き出し用
let pendingStrokeStart: { x: number; y: number; pressure: number } | null = null;
let strokeStarted = false;
const STROKE_START_THRESHOLD = 2; // ピクセル: この距離以上動いたらストローク開始（paintchatは3だが体感改善のため2に）

// 描画中（CanvasEngine経由）
function draw(event: MouseEvent | TouchEvent) {
	if (!canvasEngine.value) return;

	// スペースキー/移動ツールでのパン中（マウス・タッチ両対応）
	if (isPanningWithSpace.value) {
		let clientX: number, clientY: number;
		if (event instanceof MouseEvent) {
			clientX = event.clientX;
			clientY = event.clientY;
		} else if (event.touches.length > 0) {
			clientX = event.touches[0].clientX;
			clientY = event.touches[0].clientY;
		} else {
			return;
		}
		const deltaX = clientX - panStart.value.x;
		const deltaY = clientY - panStart.value.y;
		panOffset.value = {
			x: panOffset.value.x + deltaX,
			y: panOffset.value.y + deltaY,
		};
		panStart.value = { x: clientX, y: clientY };
		return;
	}

	const point = getEventPoint(event);

	// カーソル位置を他のユーザーに送信
	sendCursorPosition(point);

	if (!isDrawing.value || currentTool.value === 'eyedropper') return;

	// 遅延書き出し: 一定距離以上動いたらbeginStroke
	if (pendingStrokeStart && !strokeStarted) {
		const dx = point.x - pendingStrokeStart.x;
		const dy = point.y - pendingStrokeStart.y;
		if (Math.sqrt(dx * dx + dy * dy) < STROKE_START_THRESHOLD) return;
		// 十分動いたのでストローク開始
		canvasEngine.value.beginStroke(pendingStrokeStart.x, pendingStrokeStart.y, pendingStrokeStart.pressure);
		strokeStarted = true;
		pendingStrokeStart = null;
	}

	if (!strokeStarted) return;

	const pressure = calculatePressure();
	const pressurePoint: PressurePoint = { x: point.x, y: point.y, pressure };
	currentPath.push(pressurePoint);

	// CanvasEngine経由でストローク進行（スムージング・プレビュー描画込み）
	canvasEngine.value.moveStroke(point.x, point.y, pressure);

	// CanvasEngineのポイントデータで進捗送信
	const engineState = canvasEngine.value.getState();
	if (connection.value && engineState.currentPoints.length > 0) {
		const now = Date.now();
		if (now - lastProgressSent >= progressSendInterval) {
			lastProgressSent = now;
			const data = {
				points: engineState.currentPoints.slice(),
				tool: currentTool.value,
				color: currentColor.value,
				strokeWidth: strokeWidth.value,
				opacity: currentOpacity.value,
				layer: currentLayer.value,
			};
			connection.value.send('drawingProgress', data);
		}
	}
}

// 描画終了（CanvasEngine経由）
function stopDrawing() {
	// スペースキーでのパン終了
	if (isPanningWithSpace.value) {
		isPanningWithSpace.value = false;
		if (canvasEl.value && isSpaceKeyPressed.value) {
			canvasEl.value.style.cursor = 'grab';
		} else if (canvasEl.value) {
			canvasEl.value.style.cursor = 'crosshair';
		}
		return;
	}

	if (!isDrawing.value || !canvasEngine.value) return;

	isDrawing.value = false;

	// 遅延書き出し中（まだbeginStrokeしていない）の場合はキャンセル
	if (!strokeStarted) {
		pendingStrokeStart = null;
		return;
	}
	pendingStrokeStart = null;
	strokeStarted = false;

	// CanvasEngine経由でストローク確定（スムージング・スプライン適用）
	const stroke = canvasEngine.value.endStroke();

	// 一時消しゴムモード解除
	if (temporaryEraserMode) {
		temporaryEraserMode = false;
		canvasEngine.value.setState({ currentTool: originalToolBeforeEraser as any });
	}

	if (stroke) {
		stroke.userName = $i.name || $i.username;

		// カラーヒストリーに追加（ペンストロークのみ、消しゴムは除外）
		if (stroke.tool === 'pen') {
			addColorToHistory(stroke.color);
		}

		addStrokeToHistory({
			points: stroke.points,
			tool: stroke.tool,
			color: stroke.color,
			strokeWidth: stroke.width,
			opacity: stroke.opacity,
			timestamp: stroke.timestamp,
		});

		// CanvasEngineのストロークデータを直接WebSocketで送信
		if (connection.value) {
			const data = {
				id: stroke.id,
				points: stroke.points,
				tool: stroke.tool,
				color: stroke.color,
				strokeWidth: stroke.width,
				opacity: stroke.opacity,
				layer: stroke.layer ?? 0,
			};
			connection.value.send('drawingStroke', data);
		}
	}

	currentPath = [];
}

// 手ブレ補正関数
function applyHandShakeCorrectionLocal(rawPoint: { x: number; y: number }): { x: number; y: number } {
	if (!handShakeCorrection.enabled.value) return rawPoint;

	const currentTime = Date.now();

	// 初回の場合は補正なしで返す
	if (lastTime === 0) {
		smoothedPoint = rawPoint;
		lastPoint = rawPoint;
		lastTime = currentTime;
		return rawPoint;
	}

	// 距離と時間差を計算
	const distance = Math.sqrt(
		Math.pow(rawPoint.x - lastPoint.x, 2) +
		Math.pow(rawPoint.y - lastPoint.y, 2),
	);
	const timeDelta = currentTime - lastTime;

	// 現在の補正レベル設定を取得
	const settings = getCurrentCorrectionSettings();

	// 手ぶれ補正: 最小移動距離未満の場合は前の点を返す（レベルに応じて閾値変更）
	if (handShakeCorrection.stabilization.value && distance < settings.minDistance) {
		return smoothedPoint;
	}

	// 速度計算（レベルに応じてスムージング係数変更）
	if (timeDelta > 0) {
		const currentVelocity = distance / timeDelta;
		velocity = velocity * settings.velocitySmoothing + currentVelocity * (1 - settings.velocitySmoothing);

		// 速度履歴を更新（最新5つを保持）
		velocityHistory.push(velocity);
		if (velocityHistory.length > 5) {
			velocityHistory.shift();
		}
	}

	// スムージング適用（レベルに応じて補正強度変更）
	smoothedPoint = {
		x: smoothedPoint.x * settings.factor + rawPoint.x * (1 - settings.factor),
		y: smoothedPoint.y * settings.factor + rawPoint.y * (1 - settings.factor),
	};

	// バッファに追加（予測描画用）
	pointBuffer.push({ x: smoothedPoint.x, y: smoothedPoint.y, time: currentTime });
	if (pointBuffer.length > 10) {
		pointBuffer.shift();
	}

	lastPoint = rawPoint;
	lastTime = currentTime;

	return smoothedPoint;
}

// 筆圧シミュレーション（速度ベース）
function calculatePressure(): number {
	if (!handShakeCorrection.pressureSimulation.value) return 1.0;

	// 速度履歴が少ない場合（描画開始直後）は標準の太さ
	if (velocityHistory.length < 2) return 1.0;

	// 速度に基づいて筆圧を計算
	const avgVelocity = velocityHistory.reduce((a, b) => a + b, 0) / velocityHistory.length;

	// 速度が高いほど筆圧が低く（線が細く）、遅いほど筆圧が高く（線が太く）
	// 速度の正規化: 0.5以下は遅い（太い）、1.5以上は速い（細い）
	const normalizedVelocity = Math.min(avgVelocity / 1.0, 2.0); // 0〜2.0に正規化

	// より大きな変化幅を持たせる: 0.3〜1.2の範囲
	// 遅い速度（0）→ 1.2（太い）、速い速度（2.0）→ 0.3（細い）
	const pressure = Math.max(0.3, Math.min(1.2, 1.2 - normalizedVelocity * 0.45));

	return pressure;
}

// 高精度な座標計算のためのヘルパー関数（モバイル対応）
function getAccurateCoordinates(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
	// キャッシュされたrectを使用、なければリアルタイムで取得
	const rect = canvasRect.value || canvas.getBoundingClientRect();

	// CSS座標からキャンバス座標への変換
	const cssX = clientX - rect.left;
	const cssY = clientY - rect.top;

	// CSS座標をキャンバス座標にスケール
	const scaleX = canvasWidth.value / rect.width;
	const scaleY = canvasHeight.value / rect.height;

	let canvasX = cssX * scaleX;
	let canvasY = cssY * scaleY;

	// モバイルでは座標を整数に丸める（サブピクセル問題回避）
	if (isTouchDevice.value) {
		canvasX = Math.round(canvasX);
		canvasY = Math.round(canvasY);
	} else {
		// デスクトップでは高精度座標
		canvasX = Math.round(canvasX * 10) / 10;
		canvasY = Math.round(canvasY * 10) / 10;
	}

	// キャンバス境界内に制限
	const clampedX = Math.max(0, Math.min(canvasWidth.value, canvasX));
	const clampedY = Math.max(0, Math.min(canvasHeight.value, canvasY));

	return {
		x: clampedX,
		y: clampedY,
	};
}

// イベントから座標を取得
function getEventPoint(event: MouseEvent | TouchEvent): { x: number; y: number } {
	// CanvasEngine用のcanvas要素を使用
	const canvas = engineCanvasEl.value;

	let clientX: number, clientY: number;
	if (event instanceof MouseEvent) {
		clientX = event.clientX;
		clientY = event.clientY;
	} else {
		if (event.touches.length === 0) return { x: 0, y: 0 };
		clientX = event.touches[0].clientX;
		clientY = event.touches[0].clientY;
	}

	// パン/ズーム変換を考慮した座標計算を使用
	let coordinates = screenToCanvasCoordinates(
		clientX,
		clientY,
		canvas || null,
		canvasWidth.value,
		canvasHeight.value,
	);

	// キャンバス範囲内にクランプ（screenToCanvasCoordinates内部でもクランプ済み）
	coordinates.x = Math.max(0, Math.min(canvasWidth.value, coordinates.x));
	coordinates.y = Math.max(0, Math.min(canvasHeight.value, coordinates.y));

	// 手ブレ補正を適用
	return applyHandShakeCorrectionLocal(coordinates);
}

// 軌跡ログを記録
function recordTraceLog(
	type: 'touchstart' | 'touchmove' | 'touchend' | 'mousedown' | 'mousemove' | 'mouseup',
	screenX: number,
	screenY: number,
	canvasX: number,
	canvasY: number,
) {
	// ログが大きくなりすぎないよう、最大1000件に制限
	if (drawingTraceLog.value.length >= 1000) {
		drawingTraceLog.value.shift();
	}

	drawingTraceLog.value.push({
		timestamp: Date.now(),
		type,
		screenX,
		screenY,
		canvasX,
		canvasY,
		tool: currentTool.value,
		color: currentColor.value,
		strokeWidth: strokeWidth.value,
		zoomLevel: zoomLevel.value,
		panOffset: { ...panOffset.value },
	});
}








// カーソル位置送信
let lastCursorSentTime = 0;
function sendCursorPosition(point: { x: number; y: number }) {
	if (!connection.value) return;

	// 100msのレート制限（カーソル送信頻度を抑制）
	const now = Date.now();
	if (now - lastCursorSentTime < 100) return;
	lastCursorSentTime = now;

	try {
		connection.value.send('cursorMove', { x: point.x, y: point.y });
	} catch {
		// silent fail
	}
}

// カーソルタイマー管理
const cursorTimers = new Map<string, number>();

// ユーザーごとの色管理
const userCursorColors = new Map<string, string>();

// ユーザーのカーソル色を取得（ランダム生成＆キャッシュ）
function getUserCursorColorLocal(userId: string): string {
	if (!userCursorColors.has(userId)) {
		// ユーザーIDをベースにした一意で鮮やかな色を生成
		const hue = (userId.charCodeAt(0) + userId.charCodeAt(userId.length - 1)) % 360;
		const saturation = 70 + (userId.length % 30); // 70-100%
		const lightness = 45 + (userId.charCodeAt(1) % 20); // 45-65%
		const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
		userCursorColors.set(userId, color);
	}
	return userCursorColors.get(userId)!;
}

// 背景色に対する適切なコントラスト色を計算
function getContrastColorLocal(backgroundColor: string): string {
	// HSL色をRGBに変換して明度を判定
	const hslMatch = backgroundColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
	if (hslMatch) {
		const lightness = parseInt(hslMatch[3]);
		return lightness > 55 ? '#000000' : '#ffffff';
	}
	return '#ffffff'; // デフォルトは白
}

// 他のユーザーのカーソル更新
function updateOtherCursor(data: any) {
	if (data.userId === $i.id) {
		return;
	}

	// ユーザー固有の色を取得
	const userColor = getUserCursorColorLocal(data.userId);

	const index = otherCursors.value.findIndex(c => c.userId === data.userId);
	if (index >= 0) {
		otherCursors.value[index] = {
			userId: data.userId,
			userName: data.userName,
			x: data.x,
			y: data.y,
			color: userColor,
		};
	} else {
		otherCursors.value.push({
			userId: data.userId,
			userName: data.userName,
			x: data.x,
			y: data.y,
			color: userColor,
		});
	}

	// 既存のタイマーをクリア
	const existingTimer = cursorTimers.get(data.userId);
	if (existingTimer) {
		window.clearTimeout(existingTimer);
	}

	// 新しいタイマーを設定
	const timer = window.setTimeout(() => {
		const idx = otherCursors.value.findIndex(c => c.userId === data.userId);
		if (idx >= 0) {
			otherCursors.value.splice(idx, 1);
		}
		cursorTimers.delete(data.userId);
	}, 5000);

	cursorTimers.set(data.userId, timer);
}

// スポイト機能（CanvasEngineのcanvasからピクセル色を取得）
function eyedropColor(point: { x: number; y: number }) {
	const canvas = engineCanvasEl.value;
	if (!canvas) return;

	const context = canvas.getContext('2d');
	if (!context) return;

	// 座標をキャンバスの実際のピクセルにクランプ
	const x = Math.max(0, Math.min(canvas.width - 1, Math.round(point.x)));
	const y = Math.max(0, Math.min(canvas.height - 1, Math.round(point.y)));

	const imageData = context.getImageData(x, y, 1, 1);
	const [r, g, b] = imageData.data;
	const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

	currentColor.value = color;
	currentTool.value = 'pen';

	// カラーヒストリーに追加（スポイト取得時）
	addColorToHistory(color);

	// CanvasEngineに色を同期
	if (canvasEngine.value) {
		canvasEngine.value.setState({ currentColor: color, currentTool: 'pen' as any });
	}

	saveUserSettings();
}

/**
 * キャンバスダウンロード
 *
 * 【仕様】
 * - 白背景レイヤー + 3枚のレイヤーを合成してダウンロード
 * - PNG形式で保存
 * - ファイル名: drawing_[タイムスタンプ].png
 *
 * 【合成順序】
 * 1. 白背景レイヤー（最背面）
 * 2. レイヤー0
 * 3. レイヤー1
 * 4. レイヤー2（最前面）
 */
function downloadCanvas() {
	try {
		// CanvasEngine経由でダウンロード（全レイヤー合成済み）
		if (!canvasEngine.value) return;

		const dataUrl = canvasEngine.value.toDataURL('image/png');
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
		downloadImage(dataUrl, `drawing_${timestamp}.png`);
	} catch (error) {
		console.error('🎨 [ERROR] Download canvas error:', error);
		os.alert({
			type: 'error',
			text: 'キャンバスのダウンロードに失敗しました',
		});
	}
}

// キャンバスクリア（確認ダイアログ付き）
/**
 * キャンバスクリア機能
 *
 * 【仕様】
 * 1. 誤操作防止のため、テキスト入力による確認ダイアログを表示
 * 2. ユーザーが「クリア」と正確に入力した場合のみクリアを実行
 * 3. ローカルのキャンバスをクリア
 * 4. WebSocketで他のユーザーにもクリアを通知
 * 5. 完了後、トーストで成功メッセージを表示
 *
 * 【クリア対象】
 * - CanvasEngineの全レイヤー内容
 * - 統合描画履歴（strokeHistory）
 * - Undo/Redoスタック（undoStack, redoStack）
 *
 * 【ダイアログ仕様】
 * - os.inputText()を使用（Misskey専用UI）
 * - タイトル: 「キャンバスクリア確認」
 * - メッセージ: 「キャンバスの全ての内容を削除します。この操作は取り消せません。削除を実行するには「クリア」と入力してください：」
 * - プレースホルダー: 「クリア」
 * - 正しい入力: 「クリア」（全角カタカナ）
 * - 入力が一致した場合: クリア実行
 * - 入力が不一致の場合: エラーメッセージを表示
 * - キャンセルの場合: 何もしない
 *
 * 【エラーハンドリング】
 * - キャンセル時: 何もしない（silent）
 * - 入力不一致時: エラーアラートを表示
 * - クリア処理でエラー発生: エラーメッセージを表示
 *
 * 【WebSocket通信】
 * - イベント名: 'clearCanvas'
 * - ペイロード: null
 * - 送信先: 同じルームの全ユーザー
 *
 * 【注意事項】
 * - この操作は取り消せません（Undoも無効）
 * - 同じルームの全ユーザーのキャンバスがクリアされます
 * - 確認ダイアログはモーダルなので、ユーザーの応答を待ちます
 * - 誤操作防止のため、「クリア」という文字列の完全一致が必要です
 */
async function clearCanvas() {
	try {
		// 部屋名またはユーザー名を取得
		let targetName = '';
		if (props.roomId) {
			// ルームチャットの場合は部屋ID（簡易表示）
			targetName = props.roomId.substring(0, 8);
		} else if (props.userId) {
			// 1対1チャットの場合はユーザーID（簡易表示）
			targetName = props.userId.substring(0, 8);
		}

		// 確認ダイアログを表示（Misskey UI）
		const { canceled, result: userInput } = await os.inputText({
			title: 'キャンバスクリア確認',
			text: 'キャンバスの全ての内容を削除します。\n\nこの操作は取り消せません。\n\n削除を実行するには「クリア」と入力してください：',
			placeholder: 'クリア',
		});

		// キャンセルされた場合
		if (canceled) {
			return;
		}

		// 入力が「クリア」でない場合は中止
		if (userInput !== 'クリア') {
			os.alert({
				type: 'error',
				title: 'エラー',
				text: '入力された値が正しくありません。「クリア」と入力してください。',
			});
			return;
		}

		// 確認が取れた場合のみクリア実行
		clearCanvasLocal();

		if (connection.value) {
			connection.value.send('clearCanvas', null);
		}

		// 成功メッセージ
		os.toast('キャンバスをクリアしました');
	} catch (error) {
		console.error('🧹 [CLEAR] Canvas clear error:', error);
		os.alert({
			type: 'error',
			title: 'エラー',
			text: 'キャンバスのクリアに失敗しました。',
		});
	}
}

/**
 * ローカルキャンバスクリア処理
 *
 * 【処理内容】
 * 1. CanvasEngineのクリア
 * 2. 描画履歴をリセット（strokeHistory, undoStack, redoStack）
 */
function clearCanvasLocal() {
	// CanvasEngineのクリア
	if (canvasEngine.value) {
		canvasEngine.value.clear();
	}

	// 描画履歴をリセット
	strokeHistory.value = [];
	undoStack.value = [];
	redoStack.value = [];
}

// ズームをリセット
function resetZoom() {
	zoomLevel.value = 1;
	panOffset.value = { x: 0, y: 0 };
	zoomCenter.value = { x: 0, y: 0 };

	// 設定を自動保存
	saveUserSettings();
}

// ズームイン（拡大）
function zoomIn() {
	const newZoom = Math.min(zoomLevel.value * 1.2, maxZoom);
	zoomLevel.value = newZoom;

	// 設定を自動保存
	saveUserSettings();
}

// ズームアウト（縮小）
function zoomOut() {
	const newZoom = Math.max(zoomLevel.value / 1.2, 0.1);
	zoomLevel.value = newZoom;

	// 設定を自動保存
	saveUserSettings();
}

// マウスホイールによるズーム
function handleWheel(event: WheelEvent) {
	event.preventDefault();

	if (event.ctrlKey || event.metaKey) {
		// ピンチズーム（Ctrl+wheel / トラックパッドピンチ）
		const delta = -event.deltaY;
		const zoomFactor = delta > 0 ? 1.1 : 0.9;
		const newZoom = Math.max(minZoom, Math.min(maxZoom, zoomLevel.value * zoomFactor));
		zoomLevel.value = newZoom;
		saveUserSettings();
	} else {
		// 2本指スワイプ → パン移動（トラックパッド / マウスホイール）
		panOffset.value = {
			x: panOffset.value.x - event.deltaX,
			y: panOffset.value.y - event.deltaY,
		};
	}
}

// キャンバスサイズ変更ダイアログを表示
async function showCanvasSizeDialog() {
	// Width入力
	const { canceled: widthCanceled, result: width } = await os.inputText({
		title: '幅 (Width) を入力',
		placeholder: '800',
		default: String(canvasWidth.value),
	});
	if (widthCanceled) return;

	// Height入力
	const { canceled: heightCanceled, result: height } = await os.inputText({
		title: '高さ (Height) を入力',
		placeholder: '600',
		default: String(canvasHeight.value),
	});
	if (heightCanceled) return;

	const w = parseInt(width);
	const h = parseInt(height);

	if (isNaN(w) || isNaN(h) || w < 100 || h < 100 || w > 4000 || h > 4000) {
		os.alert({
			type: 'error',
			text: 'サイズは100〜4000の範囲で指定してください',
		});
		return;
	}

	await changeCanvasSize(w, h);
}

// コンテナサイズに合わせてdisplayサイズを更新
function updateDisplaySize() {
	if (!canvasContainerEl.value) return;

	const container = canvasContainerEl.value;
	const containerRect = container.getBoundingClientRect();

	// パディングを考慮（CSS: padding: 8px）
	const padding = 16; // 8px × 2
	const containerWidth = containerRect.width - padding;
	const containerHeight = containerRect.height - padding;

	// コンテナサイズが0の場合はスキップ（DOMレンダリング前）
	if (containerWidth <= 0 || containerHeight <= 0) return;

	// キャンバスのアスペクト比
	const canvasAspect = canvasWidth.value / canvasHeight.value;
	const containerAspect = containerWidth / containerHeight;

	// コンテナに収まるようにdisplayサイズを計算
	if (containerAspect > canvasAspect) {
		// コンテナが横長 → 高さに合わせる
		displayHeight.value = containerHeight;
		displayWidth.value = containerHeight * canvasAspect;
	} else {
		// コンテナが縦長 → 幅に合わせる
		displayWidth.value = containerWidth;
		displayHeight.value = containerWidth / canvasAspect;
	}
}

// キャンバスサイズを変更
async function changeCanvasSize(newWidth: number, newHeight: number, isRemote = false) {
	// 新しいサイズを設定
	canvasWidth.value = newWidth;
	canvasHeight.value = newHeight;

	// コンテナサイズに合わせてdisplayサイズを更新
	updateDisplaySize();

	// 次のフレームで実行（テンプレートのバインディングが適用された後）
	await nextTick();

	// ズームをリセット
	resetZoom();

	os.toast(`キャンバスサイズを ${newWidth}×${newHeight} に変更しました`);

	// ルーム設定を保存
	await saveRoomSettings();

	// 他のユーザーにキャンバスサイズ変更を通知（リモート起因の変更でない場合のみ）
	if (!isRemote && connection.value) {
		const data = {
			width: newWidth,
			height: newHeight,
			userId: $i?.id,
			userName: $i?.username,
			timestamp: Date.now(),
		};
		connection.value.send('canvasSizeChange', data);
	}
}


// Undo（元に戻す）
/**
 * Undo（元に戻す）
 *
 * 【仕様】
 * - 現在のレイヤーの自分の最後のストロークを1つ削除
 * - 削除したストロークをredoスタックに保存
 * - キャンバスを再描画
 * - 他のユーザーにundoイベントを送信
 *
 * 【ユーザーごとの履歴】
 * - 自分のストローク（userId === $i.id）のみを削除
 * - 他のユーザーのストロークは削除しない
 *
 * 【レイヤー対応】
 * - CanvasEngine経由で現在のレイヤーのストロークを操作
 */
// リドゥ用: アンドゥしたストロークデータを保存
const undoneStrokes = ref<any[]>([]);

function undo() {
	if (!canvasEngine.value) return;

	// CanvasEngine経由のアンドゥ（ストロークデータを返す）
	const removedStroke = canvasEngine.value.undo();
	if (removedStroke) {
		// リドゥ用にストロークデータを保存
		undoneStrokes.value.push(removedStroke);
		if (undoneStrokes.value.length > 3) undoneStrokes.value.shift();

		if (connection.value) {
			const data = { layer: currentLayer.value, strokeId: removedStroke.id, userId: $i?.id, userName: $i?.username };
			connection.value.send('undoStroke', data);
			recordCommLog('send', 'undoStroke', data);
		}
	}
}

/**
 * Redo（やり直す）
 *
 * 【仕様】
 * - redoスタックから最後に削除した自分のストロークを復元
 * - 元の位置にストロークを挿入
 * - キャンバスを再描画
 * - 他のユーザーにredoイベントを送信
 *
 * 【ユーザーごとの履歴】
 * - 自分が削除したストロークのみを復元
 * - 元の位置（originalIndex）に挿入
 *
 * 【レイヤー対応】
 * - redoスタックに保存されているレイヤー情報を使用
 * - そのレイヤーの履歴にストロークを挿入
 * - 該当レイヤーのキャンバスを再描画
 */
function redo() {
	if (!canRedo.value || !canvasEngine.value) return;

	// CanvasEngine経由のリドゥ（アンドゥしたストロークを再追加）
	if (undoneStrokes.value.length > 0) {
		const stroke = undoneStrokes.value.pop();
		if (stroke) {
			canvasEngine.value.drawRemoteStroke(stroke);
			if (connection.value) {
				const data = {
					id: stroke.id,
					points: stroke.points,
					tool: stroke.tool,
					color: stroke.color,
					strokeWidth: stroke.width ?? stroke.strokeWidth,
					opacity: stroke.opacity,
					layer: stroke.layer ?? 0,
				};
				connection.value.send('drawingStroke', data);
				recordCommLog('send', 'drawingStroke(redo)', data);
			}
		}
	}
}


/**
 * リモートユーザーのキャンバスサイズ変更イベントを処理
 *
 * 【仕様】
 * - 他のユーザーがキャンバスサイズを変更した際に呼ばれる
 * - 自動的に同じサイズに変更する
 * - 描画内容は保持される
 *
 * 【パラメータ】
 * - data.width: 新しい幅
 * - data.height: 新しい高さ
 * - data.userId: 変更したユーザーID
 * - data.userName: 変更したユーザー名
 */
async function handleRemoteCanvasSizeChange(data: any) {
	if (data.userId === $i.id) return; // 自分のイベントは無視

	const newWidth = data.width;
	const newHeight = data.height;

	if (typeof newWidth !== 'number' || typeof newHeight !== 'number') {
		return;
	}

	if (newWidth < 100 || newWidth > 4000 || newHeight < 100 || newHeight > 4000) {
		return;
	}

	// サイズ変更を適用（isRemote=trueで無限ループを防ぐ）
	await changeCanvasSize(newWidth, newHeight, true);

	// 通知を表示
	os.toast(`${data.userName || 'ユーザー'}がキャンバスサイズを${newWidth}×${newHeight}に変更しました`);
}

// レイヤー切り替え
function switchLayer(layerIndex: number) {
	if (layerIndex < 0 || layerIndex >= MAX_LAYERS) return;

	// 新しいレイヤーに切り替え
	currentLayer.value = layerIndex;

	// CanvasEngineにレイヤー切替を通知
	if (canvasEngine.value) {
		canvasEngine.value.setCurrentLayer(layerIndex);
	}

	saveUserSettings();
}

// レイヤーメニューを表示
async function showLayerMenu() {
	const { canceled, result } = await os.select({
		title: 'レイヤー操作',
		items: [
			{ label: 'レイヤーを結合', value: 'merge' },
			{ label: 'レイヤーを移動', value: 'move' },
			{ label: 'レイヤーをクリア', value: 'clear' },
		],
	});

	if (canceled || !result) return;

	switch (result) {
		case 'merge':
			await mergeLayersDialog();
			break;
		case 'move':
			await moveLayerDialog();
			break;
		case 'clear':
			await clearLayerDialog();
			break;
	}
}

// レイヤー結合ダイアログ
async function mergeLayersDialog() {
	const { canceled, result } = await os.select({
		title: 'レイヤー結合',
		items: [
			{ label: 'レイヤー1とレイヤー2を結合', value: 0 },
			{ label: 'レイヤー2とレイヤー3を結合', value: 1 },
		],
	});

	if (canceled || result === undefined || result === null) return;

	const layerIndex = typeof result === 'number' ? result : 0;
	await mergeLayers(layerIndex, layerIndex + 1);
}

// レイヤー結合を実行
async function mergeLayers(fromLayer: number, toLayer: number) {
	if (fromLayer < 0 || fromLayer >= MAX_LAYERS || toLayer < 0 || toLayer >= MAX_LAYERS) return;
	if (fromLayer === toLayer) return;

	// TODO: CanvasEngineにmergeLayersメソッドを追加して対応
	console.warn('mergeLayers: not yet supported in CanvasEngine');

	os.toast(`レイヤー${fromLayer + 1}とレイヤー${toLayer + 1}を結合しました`);
}

// レイヤー移動ダイアログ
async function moveLayerDialog() {
	const { canceled, result } = await os.select({
		title: 'レイヤー移動',
		items: [
			{ label: 'レイヤー1の内容をレイヤー2に移動', value: '0-1' },
			{ label: 'レイヤー1の内容をレイヤー3に移動', value: '0-2' },
			{ label: 'レイヤー2の内容をレイヤー1に移動', value: '1-0' },
			{ label: 'レイヤー2の内容をレイヤー3に移動', value: '1-2' },
			{ label: 'レイヤー3の内容をレイヤー1に移動', value: '2-0' },
			{ label: 'レイヤー3の内容をレイヤー2に移動', value: '2-1' },
		],
	});

	if (canceled || !result) return;

	const [from, to] = (typeof result === 'string' ? result : '0-1').split('-').map(Number);
	await moveLayer(from, to);
}

// レイヤー移動を実行
async function moveLayer(fromLayer: number, toLayer: number) {
	if (fromLayer < 0 || fromLayer >= MAX_LAYERS || toLayer < 0 || toLayer >= MAX_LAYERS) return;
	if (fromLayer === toLayer) return;

	// TODO: CanvasEngineにmoveLayerメソッドを追加して対応
	console.warn('moveLayer: not yet supported in CanvasEngine');

	os.toast(`レイヤー${fromLayer + 1}の内容をレイヤー${toLayer + 1}に移動しました`);
}

// レイヤークリアダイアログ
async function clearLayerDialog() {
	const { canceled, result } = await os.select({
		title: 'レイヤークリア',
		items: [
			{ label: 'レイヤー1をクリア', value: 0 },
			{ label: 'レイヤー2をクリア', value: 1 },
			{ label: 'レイヤー3をクリア', value: 2 },
		],
	});

	if (canceled || result === undefined || result === null) return;

	const layerIndex = typeof result === 'number' ? result : 0;

	const { canceled: confirmCanceled } = await os.confirm({
		type: 'warning',
		text: `レイヤー${layerIndex + 1}の内容をすべて削除しますか？`,
	});

	if (confirmCanceled) return;

	clearLayer(layerIndex);
}

// レイヤーをクリア
function clearLayer(layerIndex: number) {
	if (layerIndex < 0 || layerIndex >= MAX_LAYERS) return;

	// TODO: CanvasEngineにclearLayerメソッドを追加して対応
	// 現状はclear()で全レイヤーをクリアするフォールバック
	console.warn('clearLayer: not yet supported in CanvasEngine, clearing all');
	if (canvasEngine.value) {
		canvasEngine.value.clear();
	}

	if (currentLayer.value === layerIndex) {
		strokeHistory.value = [];
	}

	os.toast(`レイヤー${layerIndex + 1}をクリアしました`);
}

// デバッグログを出力（軌跡記録付き）
async function exportDebugLog() {
	const debugData = {
		timestamp: new Date().toISOString(),
		canvasInfo: {
			canvasWidth: canvasWidth.value,
			canvasHeight: canvasHeight.value,
			displayWidth: displayWidth.value,
			displayHeight: displayHeight.value,
			devicePixelRatio: window.devicePixelRatio,
		},
		currentState: {
			tool: currentTool.value,
			color: currentColor.value,
			strokeWidth: strokeWidth.value,
			opacity: currentOpacity.value,
			zoomLevel: zoomLevel.value,
			panOffset: panOffset.value,
		},
		traceLog: drawingTraceLog.value,
		strokeHistory: strokeHistory.value.map(stroke => ({
			tool: stroke.tool,
			color: stroke.color,
			strokeWidth: stroke.strokeWidth,
			pointCount: stroke.points.length,
		})),
		debugInfo: debugInfo.value,
		performance: monitorPerformance(),
	};

	// JSON形式でダウンロード
	const json = JSON.stringify(debugData, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = window.document.createElement('a');
	a.href = url;
	a.download = `drawing-debug-${Date.now()}.json`;
	a.click();
	URL.revokeObjectURL(url);

	os.toast('デバッグログを出力しました');
}

// 通信ログを記録
function recordCommLog(direction: 'send' | 'receive', type: string, data: any) {
	communicationLog.value.push({
		timestamp: Date.now(),
		direction,
		type,
		data,
	});

	// 最大エントリ数を超えたら古いログを削除
	if (communicationLog.value.length > MAX_COMM_LOG_ENTRIES) {
		communicationLog.value.shift();
	}
}

// 通信ログをクリア
function clearCommLog() {
	communicationLog.value = [];
	os.toast('通信ログをクリアしました');
}

// 通信ログを出力
async function exportCommLog() {
	const commLogData = {
		timestamp: new Date().toISOString(),
		logCount: communicationLog.value.length,
		logs: communicationLog.value.map(log => ({
			timestamp: new Date(log.timestamp).toISOString(),
			direction: log.direction,
			type: log.type,
			data: log.data,
		})),
	};

	// JSON形式でダウンロード
	const json = JSON.stringify(commLogData, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = window.document.createElement('a');
	a.href = url;
	a.download = `comm-log-${Date.now()}.json`;
	a.click();
	URL.revokeObjectURL(url);

	os.toast('通信ログを出力しました');
}

// タイムスタンプをフォーマット
function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const seconds = String(date.getSeconds()).padStart(2, '0');
	const ms = String(date.getMilliseconds()).padStart(3, '0');
	return `${hours}:${minutes}:${seconds}.${ms}`;
}

// ログデータをフォーマット
function formatLogData(data: any): string {
	if (typeof data === 'object') {
		// オブジェクトの場合は主要な情報だけ抽出
		if (data.points && Array.isArray(data.points)) {
			return `points: ${data.points.length}個, tool: ${data.tool}, color: ${data.color}`;
		} else if (data.x !== undefined && data.y !== undefined) {
			return `x: ${data.x.toFixed(1)}, y: ${data.y.toFixed(1)}`;
		} else {
			return JSON.stringify(data, null, 2);
		}
	}
	return String(data);
}

// ラッパー関数: インポートした座標変換関数を使用
function screenToCanvas(clientX: number, clientY: number): Point {
	const canvas = engineCanvasEl.value;
	return screenToCanvasCoordinates(
		clientX,
		clientY,
		canvas || null,
		canvasWidth.value,
		canvasHeight.value,
	);
}

// ラッパー関数: インポートした描画領域計算関数を使用
function getDrawingArea() {
	const canvas = engineCanvasEl.value;
	return getActualDrawingArea(
		canvas || null,
		canvasWidth.value,
		canvasHeight.value,
	);
}

// キャンバス座標をスクリーン座標に変換（スマホ向け高精度変換）
function canvasToScreenCoordinates(canvasX: number, canvasY: number): { x: number; y: number } {
	if (!canvasRect.value) return { x: canvasX, y: canvasY };

	// CSS Transformを考慮した順変換
	// transform: translate(panX, panY) scale(zoom) の順変換

	// 1. Transform Origin (基準点) を取得
	const originX = isTouchDevice.value ? zoomCenter.value.x : displayWidth.value / 2;
	const originY = isTouchDevice.value ? zoomCenter.value.y : displayHeight.value / 2;

	// 2. Scale（拡大縮小）の適用（基準点中心）
	const fromOriginX = canvasX - originX;
	const fromOriginY = canvasY - originY;

	const scaledFromOriginX = fromOriginX * zoomLevel.value;
	const scaledFromOriginY = fromOriginY * zoomLevel.value;

	const afterScaleX = scaledFromOriginX + originX;
	const afterScaleY = scaledFromOriginY + originY;

	// 3. Translate（平行移動）の適用
	const afterTranslateX = afterScaleX + panOffset.value.x;
	const afterTranslateY = afterScaleY + panOffset.value.y;

	// 4. スクリーン座標に変換
	const screenX = afterTranslateX + canvasRect.value.left;
	const screenY = afterTranslateY + canvasRect.value.top;

	return { x: screenX, y: screenY };
}

// キャンバス座標を表示座標に変換（カーソル表示用）
function canvasToDisplayCoordinates(canvasX: number, canvasY: number): { x: number; y: number } {
	// キャンバス座標（0〜4000）を表示座標（CSS pixel、パン/ズーム適用済み）に変換
	// キャンバスのCSS変換: translate(-50%, -50%) translate(panX, panY) scale(zoom)
	// transformOrigin: center

	// 1. キャンバス座標を正規化（0〜1）
	const normalizedX = canvasX / canvasWidth.value;
	const normalizedY = canvasY / canvasHeight.value;

	// 2. 表示サイズにスケール（CSS上のキャンバスサイズ）
	const displayX = normalizedX * displayWidth.value;
	const displayY = normalizedY * displayHeight.value;

	// 3. キャンバス中心を基準にした座標に変換（transformOrigin: center）
	const centerX = displayWidth.value / 2;
	const centerY = displayHeight.value / 2;
	const fromCenterX = displayX - centerX;
	const fromCenterY = displayY - centerY;

	// 4. ズームを適用（中心基準）
	const scaledFromCenterX = fromCenterX * zoomLevel.value;
	const scaledFromCenterY = fromCenterY * zoomLevel.value;

	// 5. 中心を戻す
	const afterScaleX = scaledFromCenterX + centerX;
	const afterScaleY = scaledFromCenterY + centerY;

	// 6. パンオフセットを適用
	const finalX = afterScaleX + panOffset.value.x;
	const finalY = afterScaleY + panOffset.value.y;

	return { x: finalX, y: finalY };
}

// 2本指パン用のタッチハンドラー（最適化版）
function handleTouchStart(e: TouchEvent) {
	// タッチデバイスでのネイティブスクロールを防止
	if (isTouchDevice.value) {
		e.preventDefault();
	}

	if (e.touches.length === 1) {
		// 1本指の場合は通常の描画
		startDrawing(e);
	} else if (e.touches.length === 2) {
		// 2本指の場合: パン/ズーム開始（paintchat同様: 描画中ストロークを正式終了）
		if (strokeStarted && canvasEngine.value) {
			canvasEngine.value.endStroke(); // ストロークを破棄せず正式終了（短いストロークは自然に処理）
		}
		// 遅延書き出し中（まだbeginStrokeしていない）の場合はキャンセル
		pendingStrokeStart = null;
		strokeStarted = false;
		isDrawing.value = false;
		currentPath = [];

		// 2本指ジェスチャー開始
		isPanning.value = true;
		isZooming.value = false;
		gestureState.value = 'none';

		const touch1 = e.touches[0];
		const touch2 = e.touches[1];
		const centerX = (touch1.clientX + touch2.clientX) / 2;
		const centerY = (touch1.clientY + touch2.clientY) / 2;

		// タップ判定用に開始位置を記録
		twoFingerTapStartPos.value = { x: centerX, y: centerY };

		panStart.value = { x: centerX, y: centerY };

		// ズーム中心点を論理座標系に変換
		const zoomCanvas = engineCanvasEl.value || canvasEl.value;
		if (zoomCanvas) {
			const canvasRect = zoomCanvas.getBoundingClientRect();

			// canvas要素内の相対座標
			const canvasRelativeX = centerX - canvasRect.left;
			const canvasRelativeY = centerY - canvasRect.top;

			// transform適用後のサイズ
			const transformedWidth = canvasRect.width;
			const transformedHeight = canvasRect.height;

			// 正規化座標（0-1）
			const normalizedX = canvasRelativeX / transformedWidth;
			const normalizedY = canvasRelativeY / transformedHeight;

			// 論理キャンバス座標に変換
			let logicalX = normalizedX * canvasWidth.value;
			let logicalY = normalizedY * canvasHeight.value;

			// 論理キャンバス範囲内に制限
			logicalX = Math.max(0, Math.min(canvasWidth.value, logicalX));
			logicalY = Math.max(0, Math.min(canvasHeight.value, logicalY));

			zoomCenter.value = { x: logicalX, y: logicalY };
		}

		// 初期距離を記録
		const dx = touch1.clientX - touch2.clientX;
		const dy = touch1.clientY - touch2.clientY;
		const distance = Math.sqrt(dx * dx + dy * dy);

		lastTouchDistance.value = distance;
		initialDistance.value = distance;
		distanceHistory.value = [distance];
	}
}

function handleTouchMove(e: TouchEvent) {
	// パフォーマンス向上のため、必要な場合のみpreventDefault
	if ((e.touches.length === 1 && !isPanning.value) || (e.touches.length === 2 && isPanning.value)) {
		e.preventDefault();
	}

	if (e.touches.length === 1 && !isPanning.value) {
		// 1本指の場合は通常の描画（パフォーマンス最適化）
		requestAnimationFrame(() => {
			draw(e);
		});
	} else if (e.touches.length === 2 && isPanning.value) {
		// 2本指ジェスチャー処理
		const touch1 = e.touches[0];
		const touch2 = e.touches[1];
		const centerX = (touch1.clientX + touch2.clientX) / 2;
		const centerY = (touch1.clientY + touch2.clientY) / 2;

		// 現在の2本指間の距離を計算
		const dx = touch1.clientX - touch2.clientX;
		const dy = touch1.clientY - touch2.clientY;
		const currentDistance = Math.sqrt(dx * dx + dy * dy);

		// 距離履歴を管理（スムージング用）
		distanceHistory.value.push(currentDistance);
		if (distanceHistory.value.length > 5) {
			distanceHistory.value.shift();
		}

		// 平均距離を計算してノイズを除去
		const avgDistance = distanceHistory.value.reduce((a, b) => a + b, 0) / distanceHistory.value.length;
		const distanceFromInitial = Math.abs(avgDistance - initialDistance.value);

		// パン量を計算
		const panDeltaX = centerX - panStart.value.x;
		const panDeltaY = centerY - panStart.value.y;
		const panDistance = Math.sqrt(panDeltaX * panDeltaX + panDeltaY * panDeltaY);

		// ジェスチャー判定
		if (gestureState.value === 'none') {
			// 初期状態：ズームかパンかを判定
			if (distanceFromInitial > zoomThreshold) {
				gestureState.value = 'zoom';
				isZooming.value = true;
				twoFingerTapStartPos.value = null; // タップ判定をキャンセル
			} else if (panDistance > panThreshold) {
				gestureState.value = 'pan';
				twoFingerTapStartPos.value = null; // タップ判定をキャンセル
			}
		}

		// ズーム処理
		if (gestureState.value === 'zoom' || gestureState.value === 'hybrid') {
			const zoomFactor = avgDistance / lastTouchDistance.value;
			const newZoom = Math.max(minZoom, Math.min(maxZoom, zoomLevel.value * zoomFactor));

			if (Math.abs(newZoom - zoomLevel.value) > 0.01) {
				// ズーム中心を維持するためのパンオフセット調整
				// ズーム中心（論理座標）をピクセル座標に変換
				const centerPixelX = (zoomCenter.value.x / canvasWidth.value) * displayWidth.value;
				const centerPixelY = (zoomCenter.value.y / canvasHeight.value) * displayHeight.value;

				// transformOriginが'center'なので、中心からの相対位置を計算
				const relativeCenterX = centerPixelX - displayWidth.value / 2;
				const relativeCenterY = centerPixelY - displayHeight.value / 2;

				// ズーム中心のスクリーン位置を維持するためのパンオフセット調整
				// oldScreenPos = relativeCenterX * oldZoom + oldPanX
				// newScreenPos = relativeCenterX * newZoom + newPanX
				// oldScreenPos = newScreenPos より:
				// newPanX = oldPanX + relativeCenterX * (oldZoom - newZoom)
				panOffset.value = {
					x: panOffset.value.x + relativeCenterX * (zoomLevel.value - newZoom),
					y: panOffset.value.y + relativeCenterY * (zoomLevel.value - newZoom),
				};

				zoomLevel.value = newZoom;
			}
		}

		// パン処理
		if (gestureState.value === 'pan' || gestureState.value === 'hybrid') {
			if (Math.abs(panDeltaX) > 1 || Math.abs(panDeltaY) > 1) {
				// panOffsetはピクセル単位なので、そのまま加算
				panOffset.value = {
					x: panOffset.value.x + panDeltaX,
					y: panOffset.value.y + panDeltaY,
				};
			}
		}

		// ハイブリッド状態の判定（パンとズームが同時に発生）
		if (gestureState.value === 'zoom' && panDistance > panThreshold * 2) {
			gestureState.value = 'hybrid';
			twoFingerTapStartPos.value = null; // タップ判定をキャンセル
		} else if (gestureState.value === 'pan' && distanceFromInitial > zoomThreshold * 0.5) {
			gestureState.value = 'hybrid';
			twoFingerTapStartPos.value = null; // タップ判定をキャンセル
		}

		// 基準点を更新
		panStart.value = { x: centerX, y: centerY };
		lastTouchDistance.value = avgDistance;
	}
}

function handleTouchEnd(e: TouchEvent) {
	// タッチエンド時のイベント最適化
	if (isTouchDevice.value) {
		e.preventDefault();
	}

	if (e.touches.length === 0) {
		// すべての指が離れた場合

		// 2本指タップ判定（パン/ズームが発生していない場合）
		if (isPanning.value && twoFingerTapStartPos.value && gestureState.value === 'none') {
			// 移動量を計算
			const touch1 = e.changedTouches[0];
			const touch2 = e.changedTouches[1];
			if (touch1 && touch2) {
				const endCenterX = (touch1.clientX + touch2.clientX) / 2;
				const endCenterY = (touch1.clientY + touch2.clientY) / 2;
				const moveDistance = Math.sqrt(
					Math.pow(endCenterX - twoFingerTapStartPos.value.x, 2) +
					Math.pow(endCenterY - twoFingerTapStartPos.value.y, 2),
				);

				if (moveDistance < tapMoveThreshold) {
					// タップとして認識
					const now = Date.now();
					const timeSinceLastTap = now - lastTwoFingerTap.value;

					if (timeSinceLastTap < twoFingerTapTimeout && lastTwoFingerTap.value > 0) {
						// ダブルタップ検出: アンドゥ実行
						performAdvancedUndo();
						lastTwoFingerTap.value = 0; // リセット
					} else {
						// 最初のタップ
						lastTwoFingerTap.value = now;
					}
				}
			}
		}

		twoFingerTapStartPos.value = null;
		const wasPanningOrZooming = isPanning.value || isZooming.value;
		isPanning.value = false;
		isZooming.value = false;
		gestureState.value = 'none';
		distanceHistory.value = [];

		// パン/ズーム中でなかった場合のみストローク確定
		if (!wasPanningOrZooming) {
			stopDrawing();
		} else {
			// パン/ズーム後は描画状態をリセット
			pendingStrokeStart = null;
			strokeStarted = false;
			isDrawing.value = false;
			currentPath = [];
		}

		if (wasPanningOrZooming) {
			saveUserSettings();
		}
	} else if (e.touches.length === 1 && isPanning.value) {
		// 2本指から1本指になった場合（描画は開始しない）
		twoFingerTapStartPos.value = null;
		isPanning.value = false;
		isZooming.value = false;
		gestureState.value = 'none';
		distanceHistory.value = [];
		// CanvasEngineの描画状態をリセット
		if (canvasEngine.value) {
			canvasEngine.value.setState({ isDrawing: false, currentPoints: [] });
		}
		isDrawing.value = false;
		currentPath = [];

		// パンまたはズームが行われていたため、設定を自動保存
		saveUserSettings();

		// 残った1本指で描画を開始
		startDrawing(e);
	}
}

// コンテナレベルのタッチハンドラ（キャンバス外でも2本指操作を可能にする）
function handleContainerTouchStart(e: TouchEvent) {
	// すべてのタッチをhandleTouchStartで処理
	// 1本指: 描画
	// 2本指: パン/ズーム
	handleTouchStart(e);
}

function handleContainerTouchMove(e: TouchEvent) {
	// すべてのタッチムーブをhandleTouchMoveで処理
	handleTouchMove(e);
}

function handleContainerTouchEnd(e: TouchEvent) {
	// すべてのタッチ終了をhandleTouchEndで処理
	handleTouchEnd(e);
}

// パフォーマンス監視
function monitorPerformance() {
	const stats = {
		strokeCount: strokeHistory.value.length,
		canvasSize: `${canvasWidth.value}x${canvasHeight.value}`,
		memoryUsage: (performance as any).memory ? {
			used: Math.round((performance as any).memory.usedJSHeapSize / 1024 / 1024),
			total: Math.round((performance as any).memory.totalJSHeapSize / 1024 / 1024),
			limit: Math.round((performance as any).memory.jsHeapSizeLimit / 1024 / 1024),
		} : 'N/A',
		timestamp: new Date().toISOString(),
	};

	// メモリ使用量が多い場合は警告
	if (typeof stats.memoryUsage === 'object' && stats.memoryUsage.used > 100) {
		console.warn('🎨 [WARN] High memory usage detected, consider rasterization');
		if (strokeHistory.value.length > rasterizeThreshold * 0.8) {
			performRasterization();
		}
	}

	return stats;
}

// キャンバスデータ読み込み
async function loadCanvasData() {
	try {
		const response = await window.fetch('/api/drawing/canvas', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${$i.token}`,
			},
			body: JSON.stringify({
				roomId: drawingId.value,
			}),
		});

		if (response.ok) {
			const strokes = await response.json();

			strokeHistory.value = [];
			undoStack.value = [];
			redoStack.value = [];

			// CanvasEngineでストローク復元
			if (canvasEngine.value && strokes.length > 0) {
				await canvasEngine.value.restoreStrokes(strokes);
			}
		}
	} catch (error) {
		console.warn('🎨 [WARN] Failed to load canvas data:', error);
	}
}

// ストローク履歴管理（正規化のみ、描画はCanvasEngineが行う）
function addStrokeToHistory(strokeData: any) {
	// 新しいストロークを追加したらredoスタックをクリア
	undoneStrokes.value = [];

	strokeHistory.value.push(strokeData);

	// 履歴の制限
	if (strokeHistory.value.length > maxUndoHistory) {
		strokeHistory.value.splice(0, strokeHistory.value.length - maxUndoHistory);
	}
}

// ラスタライズ実行（CanvasEngine経由）
function performRasterization() {
	// CanvasEngineが内部でストローク管理しているため、
	// ローカルの履歴のみクリアする
	strokeHistory.value = [];
}

// 改良されたアンドゥ機能
function performAdvancedUndo() {
	// CanvasEngine経由のアンドゥ（2本指ダブルタップ用）
	undo();
}


// チャットオーバーレイ表示
function showChatOverlay(message: any) {
	if (message.fromUserId === $i.id) return;

	chatOverlay.value = {
		user: message.fromUser,
		text: message.text,
	};

	// 3秒後に非表示
	window.setTimeout(() => {
		chatOverlay.value = null;
	}, 3000);
}

// 全画面モード制御
async function toggleFullscreen() {
	try {
		if (!window.document.fullscreenElement) {
			const rootElement = window.document.querySelector('.drawing-root') as HTMLElement;
			if (rootElement) {
				await rootElement.requestFullscreen();
			}
		} else {
			await window.document.exitFullscreen();
		}
	} catch (error) {
		console.warn('🎨 [WARN] Fullscreen toggle failed:', error);
	}
}

// 全画面状態変更ハンドラー
function handleFullscreenChange() {
	isFullscreen.value = !!window.document.fullscreenElement;

	// 全画面モード時にタッチデバイス向けのスタイル調整
	if (isFullscreen.value && isTouchDevice.value) {
		// キャンバスサイズを動的に調整
		nextTick(() => {
			adjustCanvasForMobile();
		});
	}
}

// スマホ向けキャンバス調整
function adjustCanvasForMobile() {
	const canvas = engineCanvasEl.value;
	if (!canvas || !isTouchDevice.value) return;

	const container = canvas.parentElement;
	if (!container) return;

	// コンテナサイズに合わせてキャンバスを調整
	const containerRect = container.getBoundingClientRect();
	const maxWidth = containerRect.width - 32; // padding考慮
	const maxHeight = containerRect.height - 32;

	// アスペクト比を維持しながらリサイズ
	const aspectRatio = canvasWidth.value / canvasHeight.value;
	let newWidth = maxWidth;
	let newHeight = maxWidth / aspectRatio;

	if (newHeight > maxHeight) {
		newHeight = maxHeight;
		newWidth = maxHeight * aspectRatio;
	}

	canvas.style.width = `${newWidth}px`;
	canvas.style.height = `${newHeight}px`;
}
</script>

<style lang="scss" module>
.loadingOverlay {
	position: absolute;
	inset: 0;
	z-index: 100;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(255, 255, 255, 0.6);
	pointer-events: none;
}

.loadingSpinner {
	width: 28px;
	height: 28px;
	border: 3px solid var(--MI_THEME-divider);
	border-top-color: var(--MI_THEME-accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}

@keyframes spin {
	to { transform: rotate(360deg); }
}

.root {
	display: flex;
	flex-direction: row;
	position: relative;
	height: calc(100dvh - 55px);
	overflow: hidden;
	background: var(--MI_THEME-panel);
	margin: -24px 0 -48px 0;
	padding: 0;

	&:fullscreen {
		background: #000000;

		.toolbar {
			background: rgba(0, 0, 0, 0.8);
			backdrop-filter: blur(8px);
			border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		}

		.canvasContainer {
			background: #000000;
			padding: 8px;
		}
	}
}

// モバイル用ツールバー開閉ボタン
.toolbarToggle {
	position: fixed;
	bottom: 20px;
	right: 20px;
	width: 56px;
	height: 56px;
	border-radius: 50%;
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-accentForeground);
	border: none;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 24px;
	cursor: pointer;
	z-index: 1000;
	transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

	&:hover {
		transform: scale(1.1);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
	}

	&:active {
		transform: scale(0.95);
	}

	i {
		transition: transform 0.3s ease;
	}

	&.toolbarToggleOpen {
		background: var(--MI_THEME-error);

		i {
			transform: rotate(90deg);
		}
	}
}

.toolbar {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	padding: 4px 2px;
	background: var(--MI_THEME-bg);
	border-right: 1px solid var(--MI_THEME-divider);
	width: 42px;
	min-width: 42px;

	// スマホ: 余白を最小化
	@media (max-width: 700px) {
		gap: 2px;
		padding: 1px 0;
		width: 36px;
		min-width: 36px;
	}
	overflow-y: auto;
	overflow-x: hidden;
	scrollbar-width: none;
	-ms-overflow-style: none;

	&::-webkit-scrollbar {
		display: none;
	}

	// モバイル用フローティングツールバー
	&.toolbarMobile {
		position: fixed;
		bottom: 90px;
		left: 50%;
		transform: translateX(-50%) translateY(150%);
		width: 90%;
		max-width: 500px;
		max-height: 60vh;
		overflow-y: auto;
		border-radius: 16px;
		border: 1px solid var(--MI_THEME-divider);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
		backdrop-filter: blur(12px);
		background: rgba(var(--MI_THEME-panel-rgb), 0.95);
		z-index: 999;
		transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
		padding: 16px;
		gap: 12px;

		&.toolbarMobileOpen {
			transform: translateX(-50%) translateY(0);
		}
	}
}

@container (max-width: 500px) {
	.toolbar {
		gap: 8px;
		padding: 8px 12px;
		flex-wrap: wrap;
		justify-content: center;

		.actionGroup {
			margin-left: 0;
			width: 100%;
			justify-content: center;
		}
	}

	.toolGroup {
		gap: 2px;
	}

	.colorPalette {
		gap: 2px;
		max-width: 200px;
		flex-wrap: wrap;
	}

	.strokeWidthGroup {
		gap: 4px;
		.label {
			display: none;
		}
	}

	.strokeWidthButton {
		width: 36px;
		height: 36px;
	}

	.opacityGroup {
		gap: 4px;
		.label {
			display: none;
		}
	}

	.toolButton {
		width: 44px;
		height: 44px;
		font-size: 18px;
	}

	.colorButton {
		width: 28px;
		height: 28px;
	}

	.colorPickerButton {
		width: 28px;
		height: 28px;
	}

	.fullscreenButton,
	.saveButton,
	.clearButton {
		min-width: 44px;
		height: 44px;
		span {
			display: none;
		}
	}
}

.toolGroup {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.separator {
	height: 1px;
	background: var(--MI_THEME-divider);
	margin: 4px 0;
}

.colorDot {
	width: 20px;
	height: 20px;
	border-radius: 50%;
	border: 2px solid var(--MI_THEME-divider);
}

.layerIcon {
	font-size: 14px;
	font-weight: bold;
}

.toolPanel {
	position: absolute;
	left: 43px;

	@media (max-width: 700px) {
		left: 37px;
	}
	top: 0;
	width: 200px;
	max-height: 100%;
	overflow-y: auto;
	background: var(--MI_THEME-panel);
	border-right: 1px solid var(--MI_THEME-divider);
	box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
	z-index: 100;
	padding: 8px;
}

.toolPanelHeader {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding-bottom: 8px;
	border-bottom: 1px solid var(--MI_THEME-divider);
	margin-bottom: 8px;
	font-size: 13px;
	font-weight: bold;
}

.toolPanelClose {
	background: none;
	border: none;
	color: var(--MI_THEME-fg);
	cursor: pointer;
	font-size: 12px;
	opacity: 0.7;

	&:hover { opacity: 1; }
}

.colorPickerRow {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
}

.nativeColorPicker {
	width: 32px;
	height: 32px;
	border: none;
	cursor: pointer;
	padding: 0;
}

.colorHex {
	font-size: 12px;
	font-family: monospace;
	color: var(--MI_THEME-fg);
}

.panelLabel {
	font-size: 11px;
	color: var(--MI_THEME-fg);
	opacity: 0.7;
	margin: 8px 0 4px;
}

.colorGrid {
	display: grid;
	grid-template-columns: repeat(5, 1fr);
	gap: 3px;
}

.colorCell {
	width: 100%;
	aspect-ratio: 1;
	border: 2px solid transparent;
	border-radius: 4px;
	cursor: pointer;
	transition: transform 0.1s;

	&:hover { transform: scale(1.1); }
}

.colorSelected {
	border-color: var(--MI_THEME-accent);
	box-shadow: 0 0 0 1px var(--MI_THEME-accent);
}

.widthGrid {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 4px;
}

.widthCell {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	padding: 4px;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: 4px;
	background: var(--MI_THEME-panel);
	color: var(--MI_THEME-fg);
	cursor: pointer;

	&:hover { background: var(--MI_THEME-buttonHoverBg); }
}

.widthSelected {
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-fgOnAccent);
	border-color: var(--MI_THEME-accent);
}

.widthCircle {
	background: var(--MI_THEME-fg);
	border-radius: 50%;
	.widthSelected & { background: var(--MI_THEME-fgOnAccent); }
}

.widthLabel {
	font-size: 10px;
	color: var(--MI_THEME-fg);
}

.pressureToggle {
	margin-bottom: 8px;
}

.toggleLabel {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
	cursor: pointer;
	color: var(--MI_THEME-fg);
}

.opacitySlider {
	width: 100%;
	margin: 4px 0;
}

.panelBtn {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 8px;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: 6px;
	background: var(--MI_THEME-panel);
	color: var(--MI_THEME-fg);
	cursor: pointer;
	font-size: 13px;
	margin-bottom: 4px;

	&:hover { background: var(--MI_THEME-buttonHoverBg); }
	&:disabled { opacity: 0.5; cursor: not-allowed; }
}

.panelBtnActive {
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-fgOnAccent);
	border-color: var(--MI_THEME-accent);
}

.toolButton {
	width: 36px;
	height: 36px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	color: var(--MI_THEME-fg);
	border-radius: 6px;

	// スマホ: コンパクトに
	@media (max-width: 700px) {
		width: 34px;
		height: 34px;
		border-radius: 4px;
	}
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: all 0.2s;
	font-size: 16px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.active {
		background: var(--MI_THEME-accent);
		color: var(--MI_THEME-fgOnAccent);
		border-color: var(--MI_THEME-accent);
	}

	&.highlight {
		animation: toolHighlightPulse 1.5s ease-in-out infinite;
		color: var(--MI_THEME-accent);
	}
}

@keyframes toolHighlightPulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}

.colorPalette {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 2px;
}

.colorButton {
	width: 16px;
	height: 16px;
	border: 2px solid var(--MI_THEME-divider);
	border-radius: 4px;
	cursor: pointer;
	transition: all 0.2s;

	&:hover {
		transform: scale(1.1);
	}

	&.activeColor {
		border-color: var(--MI_THEME-accent);
		box-shadow: 0 0 0 2px var(--MI_THEME-accent);
	}
}

.colorPickerButton {
	width: 24px;
	height: 24px;
	border: 2px solid var(--MI_THEME-divider);
	border-radius: 4px;
	cursor: pointer;
	background: var(--MI_THEME-buttonBg);
	color: var(--MI_THEME-fg);
	display: flex;
	align-items: center;
	justify-content: center;
	transition: all 0.2s;

	i {
		font-size: 14px;
	}

	&:hover {
		transform: scale(1.1);
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.strokeWidthGroup {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
}

.strokeWidthButton {
	width: 32px;
	height: 32px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 4px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: all 0.2s;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.active {
		background: var(--MI_THEME-accent);
		border-color: var(--MI_THEME-accent);
	}
}

.strokePreview {
	background: var(--MI_THEME-fg);
	border-radius: 50%;
	transition: all 0.2s;

	.strokeWidthButton.active & {
		background: var(--MI_THEME-fgOnAccent);
	}
}

.opacityGroup {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
}

.label {
	font-size: 10px;
	color: var(--MI_THEME-fg);
	text-align: center;
	white-space: nowrap;
}

.opacityButton {
	padding: 4px 8px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 4px;
	cursor: pointer;
	font-size: 11px;
	transition: all 0.2s;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.active {
		background: var(--MI_THEME-accent);
		color: var(--MI_THEME-fgOnAccent);
		border-color: var(--MI_THEME-accent);
	}
}

.zoomGroup {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-left: auto;
	margin-right: 8px;

	.label {
		font-size: 12px;
		color: var(--MI_THEME-fg);
		font-weight: 500;
	}

	.zoomDisplay {
		font-size: 14px;
		font-weight: bold;
		color: var(--MI_THEME-accent);
		min-width: 40px;
		text-align: center;
	}

	.zoomButton,
	.zoomResetButton {
		padding: 4px 8px;
		border: 1px solid var(--MI_THEME-divider);
		background: var(--MI_THEME-panel);
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--MI_THEME-fg);
		transition: all 0.2s ease;

		&:hover {
			background: var(--MI_THEME-buttonHoverBg);
			color: var(--MI_THEME-accent);
		}

		&:active {
			transform: scale(0.95);
		}

		i {
			font-size: 14px;
		}
	}
}

.layerGroup {
	display: flex;
	align-items: center;
	gap: 4px;
	margin-right: 8px;

	.label {
		font-size: 12px;
		color: var(--MI_THEME-fg);
		font-weight: 500;
	}
}

.layerButton {
	padding: 4px 12px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 4px;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
	color: var(--MI_THEME-fg);
	transition: all 0.2s ease;
	min-width: 32px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.active {
		background: var(--MI_THEME-accent);
		color: var(--MI_THEME-fgOnAccent);
		border-color: var(--MI_THEME-accent);
	}
}

.layerMenuButton {
	padding: 4px 8px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 4px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--MI_THEME-fg);
	transition: all 0.2s ease;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
		color: var(--MI_THEME-accent);
	}

	i {
		font-size: 16px;
	}
}

.undoRedoGroup {
	display: flex;
	gap: 4px;
	margin-right: 8px;
}

.undoButton,
.redoButton {
	padding: 6px 12px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 6px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--MI_THEME-fg);
	transition: all 0.2s;

	&:hover:not(.disabled) {
		background: var(--MI_THEME-accentedBg);
	}

	&.disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
}

.actionGroup {
	margin-left: auto;
	display: flex;
	gap: 8px;
}

.fullscreenButton {
	padding: 6px 12px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 6px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--MI_THEME-accent);
	transition: all 0.2s;

	&:hover {
		background: var(--MI_THEME-accentedBg);
	}
}

.settingsButton {
	padding: 6px 12px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 6px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--MI_THEME-fg);
	transition: all 0.2s;

	&:hover {
		background: var(--MI_THEME-accentedBg);
	}
}

.debugExportButton {
	padding: 6px 12px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 6px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--MI_THEME-fg);
	transition: all 0.2s;

	&:hover {
		background: var(--MI_THEME-accentedBg);
	}
}

.saveButton {
	padding: 6px 12px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 6px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--MI_THEME-accent);
	transition: all 0.2s;

	&:hover {
		background: var(--MI_THEME-accentedBg);
	}
}

.clearButton {
	padding: 6px 12px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 6px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--MI_THEME-error);
	transition: all 0.2s;

	&:hover {
		background: var(--MI_THEME-errorBg);
	}
}

.canvasContainer {
	flex: 1;
	position: relative;
	overflow: hidden;
	display: flex;
	justify-content: center;
	align-items: flex-start;
	background: var(--MI_THEME-bg);
	padding: 8px;
	touch-action: none;
}

.canvas {
	position: absolute;
	top: 50%;
	left: 50%;
	border: 1px solid var(--MI_THEME-divider);
	touch-action: none;
	border-radius: 8px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	background: #ffffff;
	box-sizing: border-box;
}

.layerCanvas {
	background: transparent;
}

@container (max-width: 600px) {
	.canvasContainer {
		padding: 4px;
	}

	.canvas {
		max-width: calc(100vw - 8px);
		max-height: calc(100vh - 120px); /* ツールバー分を考慮 */
		border-radius: 4px;
		object-fit: contain;
	}
}

@container (max-width: 400px) {
	.canvasContainer {
		padding: 2px;
	}

	.canvas {
		max-width: calc(100vw - 4px);
		max-height: calc(100vh - 100px); /* ツールバー分を考慮 */
		border-radius: 4px;
		object-fit: contain;
	}
}

// 全画面モード時の最適化
.root:fullscreen {
	@container (max-width: 1000px) {
		.toolbar {
			padding: 6px;
			gap: 6px;
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			z-index: 1000;
		}

		.canvasContainer {
			padding-top: 60px; /* ツールバーの高さ分 */
		}
	}

	.canvas {
		max-width: 95vw;
		max-height: 85vh;
		width: auto !important;
		height: auto !important;
		border: 2px solid rgba(255, 255, 255, 0.3);
		box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
	}
}

.cursor {
	position: absolute;
	pointer-events: none;
	z-index: 10;
	font-size: 18px;
	transition: all 0.1s ease;
	filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.cursorUser {
	position: absolute;
	top: -32px;
	left: 22px;
	padding: 4px 8px;
	border-radius: 6px;
	font-size: 12px;
	font-weight: 500;
	white-space: nowrap;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
	border: 1px solid rgba(255, 255, 255, 0.2);
	backdrop-filter: blur(4px);
	animation: fadeInCursor 0.2s ease;
}

@keyframes fadeInCursor {
	from {
		opacity: 0;
		transform: scale(0.8) translateY(4px);
	}
	to {
		opacity: 1;
		transform: scale(1) translateY(0);
	}
}

.chatOverlay {
	position: absolute;
	bottom: 20px;
	left: 20px;
	z-index: 20;
}

.chatBubble {
	display: flex;
	align-items: center;
	gap: 8px;
	background: var(--MI_THEME-panel);
	border: 1px solid var(--MI_THEME-divider);
	border-radius: 12px;
	padding: 8px 12px;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
	max-width: 300px;
}

.chatAvatar {
	flex-shrink: 0;
}

.chatText {
	font-size: 14px;
	color: var(--MI_THEME-fg);
}

.chat-overlay-enter-active,
.chat-overlay-leave-active {
	transition: all 0.3s ease;
}

.chat-overlay-enter-from,
.chat-overlay-leave-to {
	opacity: 0;
	transform: translateY(20px);
}

// マウス補正設定スタイル
.mouseCorrectionGroup {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px;
	background: var(--MI_THEME-buttonBg);
	border-radius: 6px;
}

.correctionButton {
	background: transparent;
	border: 1px solid var(--MI_THEME-divider);
	border-radius: 4px;
	padding: 6px;
	color: var(--MI_THEME-fg);
	cursor: pointer;
	transition: all 0.2s ease;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	font-size: 14px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
		color: var(--MI_THEME-accent);
		border-color: var(--MI_THEME-accent);
	}

	&.active {
		background: var(--MI_THEME-accent);
		color: var(--MI_THEME-accentFg);
		border-color: var(--MI_THEME-accent);
		box-shadow: 0 0 4px rgba(var(--MI_THEME-accent-rgb), 0.3);
	}

	i {
		font-size: 12px;
	}
}

.touchCorrectionGroup {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px;
	background: var(--MI_THEME-buttonBg);
	border-radius: 6px;
}

.correctionLevelGroup {
	display: flex;
	align-items: center;
	gap: 2px;
	margin-left: 4px;
}

.levelLabel {
	font-size: 10px;
	color: var(--MI_THEME-fgTransparentWeak);
	margin-right: 2px;
}

.levelButton {
	background: transparent;
	border: 1px solid var(--MI_THEME-divider);
	color: var(--MI_THEME-fg);
	padding: 4px;
	border-radius: 3px;
	cursor: pointer;
	transition: all 0.2s ease;
	width: 24px;
	height: 24px;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 11px;
	font-weight: bold;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
		border-color: var(--MI_THEME-accent);
		color: var(--MI_THEME-accent);
	}

	&.active {
		background: var(--MI_THEME-accent);
		color: var(--MI_THEME-accentFg);
		border-color: var(--MI_THEME-accent);
		box-shadow: 0 0 4px rgba(var(--MI_THEME-accent-rgb), 0.3);
	}
}

@container (max-width: 500px) {
	.mouseCorrectionGroup, .touchCorrectionGroup {
		gap: 2px;
	}

	.correctionButton {
		width: 24px;
		height: 24px;
		padding: 4px;

		i {
			font-size: 10px;
		}
	}

	.levelButton {
		width: 20px;
		height: 20px;
		font-size: 9px;
	}

	.levelLabel {
		font-size: 8px;
	}
}

.debugButton {
	padding: 4px 8px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 4px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--MI_THEME-fg);
	transition: all 0.2s ease;
	margin-left: 4px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
		color: var(--MI_THEME-accent);
		border-color: var(--MI_THEME-accent);
	}

	i {
		font-size: 16px;
	}
}

.debugPanel {
	position: absolute;
	top: 10px;
	right: 10px;
	background: var(--MI_THEME-panel);
	border: 1px solid var(--MI_THEME-divider);
	border-radius: 8px;
	width: 320px;
	max-height: 80vh;
	overflow-y: auto;
	z-index: 1000;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.debugHeader {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 12px 16px;
	border-bottom: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-bg);

	h4 {
		margin: 0;
		font-size: 14px;
		font-weight: bold;
		color: var(--MI_THEME-fg);
	}
}

.debugCloseButton {
	background: none;
	border: none;
	color: var(--MI_THEME-fg);
	cursor: pointer;
	font-size: 18px;
	padding: 2px 6px;
	border-radius: 4px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.debugContent {
	padding: 8px 12px;
	font-size: 11px;
	line-height: 1.3;
}

.debugSection {
	margin-bottom: 12px;

	h5 {
		margin: 0 0 4px 0;
		font-size: 12px;
		font-weight: bold;
		color: var(--MI_THEME-accent);
	}

	p {
		margin: 2px 0;
		color: var(--MI_THEME-fg);
		font-family: monospace;
		background: var(--MI_THEME-bg);
		padding: 2px 4px;
		border-radius: 2px;
		word-break: break-all;
	}
}

@container (max-width: 500px) {
	.debugPanel {
		width: 280px;
		right: 5px;
		top: 5px;
		max-height: 70vh;
	}

	.debugContent {
		font-size: 10px;
		padding: 6px 8px;
	}

	.debugSection {
		margin-bottom: 8px;

		h5 {
			font-size: 11px;
		}
	}
}

// 通信ログパネル
.commLogPanel {
	position: absolute;
	top: 10px;
	left: 10px;
	background: var(--MI_THEME-panel);
	border: 1px solid var(--MI_THEME-divider);
	border-radius: 8px;
	width: 420px;
	max-height: 80vh;
	overflow-y: hidden;
	z-index: 1000;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
	display: flex;
	flex-direction: column;
}

.commLogHeader {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 12px 16px;
	border-bottom: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-bg);
	flex-shrink: 0;

	h4 {
		margin: 0;
		font-size: 14px;
		font-weight: bold;
		color: var(--MI_THEME-fg);
	}
}

.commLogActions {
	display: flex;
	gap: 8px;
}

.commLogClearButton {
	background: var(--MI_THEME-buttonBg);
	border: 1px solid var(--MI_THEME-buttonBorder);
	color: var(--MI_THEME-fg);
	cursor: pointer;
	font-size: 12px;
	padding: 4px 12px;
	border-radius: 4px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.commLogCloseButton {
	background: none;
	border: none;
	color: var(--MI_THEME-fg);
	cursor: pointer;
	font-size: 18px;
	padding: 2px 6px;
	border-radius: 4px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.commLogContent {
	padding: 8px;
	font-size: 11px;
	line-height: 1.3;
	overflow-y: auto;
	flex: 1;
	min-height: 0;
}

.commLogEmpty {
	color: var(--MI_THEME-fgTransparentWeak);
	text-align: center;
	padding: 20px;
}

.commLogEntry {
	margin-bottom: 8px;
	padding: 8px;
	border-radius: 4px;
	border-left: 3px solid;
	background: var(--MI_THEME-bg);
}

.commLogsend {
	border-left-color: #4caf50;
	background: rgba(76, 175, 80, 0.05);
}

.commLogreceive {
	border-left-color: #2196f3;
	background: rgba(33, 150, 243, 0.05);
}

.commLogTime {
	font-size: 10px;
	color: var(--MI_THEME-fgTransparentWeak);
	margin-bottom: 4px;
	font-family: monospace;
}

.commLogType {
	display: flex;
	gap: 8px;
	margin-bottom: 4px;
}

.commLogDirection {
	font-weight: bold;
	font-size: 10px;
	padding: 2px 6px;
	border-radius: 3px;

	.commLogsend & {
		background: #4caf50;
		color: white;
	}

	.commLogreceive & {
		background: #2196f3;
		color: white;
	}
}

.commLogEventType {
	font-family: monospace;
	font-size: 11px;
	color: var(--MI_THEME-fg);
}

.commLogData {
	margin-top: 4px;
	font-family: monospace;
	font-size: 10px;
	color: var(--MI_THEME-fg);
	background: var(--MI_THEME-panel);
	padding: 4px 6px;
	border-radius: 3px;
	overflow-x: auto;
	white-space: pre-wrap;
	word-break: break-all;

	pre {
		margin: 0;
	}
}

/* ウォーターマーク関連 */
.watermarkGroup {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 12px;
	background: var(--MI_THEME-panel);
	border-radius: 8px;
	margin: 4px 0;
}

.watermarkOverlay {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	pointer-events: none;
	overflow: hidden;
	z-index: 5;
}

.watermarkTiles {
	position: absolute;
	top: -100px;
	left: -100px;
	width: calc(100% + 200px);
	height: calc(100% + 200px);
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
	gap: 30px;
	padding: 20px;
	transform: rotate(-15deg);
	pointer-events: none;
}

.watermarkImage {
	width: 60px;
	height: auto;
	opacity: 0.1;
	object-fit: contain;
	user-select: none;
	pointer-events: none;
}

.commLogButton {
	padding: 6px 12px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	border-radius: 6px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--MI_THEME-fg);
	transition: all 0.2s;

	&:hover {
		background: var(--MI_THEME-accentedBg);
	}
}

@container (max-width: 500px) {
	.commLogPanel {
		width: calc(100vw - 20px);
		left: 10px;
		top: 10px;
		max-height: 60vh;
	}

	.commLogContent {
		font-size: 10px;
		padding: 6px;
	}

	.commLogEntry {
		margin-bottom: 6px;
		padding: 6px;
	}
}

/* 他のユーザーのカーソル */
.cursor {
	position: absolute;
	pointer-events: none;
	z-index: 1000;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 4px;
}

.cursorPointer {
	width: 0;
	height: 0;
	border-left: 12px solid currentColor;
	border-top: 6px solid transparent;
	border-bottom: 6px solid transparent;
	filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}

.cursorLabel {
	padding: 2px 6px;
	border-radius: 4px;
	font-size: 11px;
	font-weight: 600;
	white-space: nowrap;
	box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
	margin-left: 12px;
}
</style>
