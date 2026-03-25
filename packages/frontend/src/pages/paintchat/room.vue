<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header>
		<MkPageHeader :actions="headerActions" :tabs="[]"/>
	</template>

	<div v-if="roomInfo" :class="$style.container">
		<!-- ヘッダー: 匿名名・プレゼンス表示 -->
		<div :class="$style.roomHeader">
			<div :class="$style.participants">
				<span :class="$style.myName">{{ myName }}</span>
				<template v-if="partnerName">
					<span :class="$style.vs">vs</span>
					<span :class="$style.partnerName">
						{{ partnerName }}
						<span v-if="partnerPresence === 'online'" :class="$style.presenceOnline"><span :class="$style.presenceDot"></span>入室中</span>
						<span v-else :class="$style.presenceOffline"><span :class="$style.presenceDotOff"></span>退室中</span>
					</span>
				</template>
			</div>
			<div :class="$style.roomInfo">
				<span :class="$style.dataNotice">データは7日間保持後に自動削除されます</span>
			</div>
		</div>

		<!-- キャンバス + サイドバーツールバー（position: relativeコンテナ） -->
		<div :class="$style.canvasArea">
			<!-- 左サイドバーツールバー（absoluteで左端に配置） -->
			<XToolbar
				v-if="canvasEngine"
				ref="toolbarRef"
				:hasUnreadChat="chatRef?.hasUnread"
				:isSolo="isSolo"
				:myConsent="myPublishConsent"
				:partnerConsent="partnerPublishConsent"
				:isPublished="isPublished"
				@toolChange="onToolChange"
				@colorChange="onColorChange"
				@widthChange="onWidthChange"
				@opacityChange="onOpacityChange"
				@undo="onUndo"
				@zoomIn="canvasCompRef?.zoomIn()"
				@zoomOut="canvasCompRef?.zoomOut()"
				@zoomReset="canvasCompRef?.zoomReset()"
				@moveMode="(enabled: boolean) => canvasCompRef?.setMoveMode(enabled)"
				@downloadAll="onDownloadAll"
				@downloadMine="onDownloadMine"
				@publishMyArt="onPublishMyArt"
				@toggleChat="onToggleChat"
				@publishConsent="onPublishConsent"
				@publishRequest="onPublishRequest"
				@report="reportRoom"
				@leave="leaveRoom"
			/>
			<!-- キャンバス（サイドバー幅分左にオフセット） -->
			<div :class="$style.canvasInner">
				<XCanvas
					v-if="canvasEngine"
					ref="canvasCompRef"
					:engine="canvasEngine"
					@strokeEnd="onStrokeEnd"
					@progress="onProgress"
					@cursorMove="onCursorMove"
					@eyedrop="onEyedrop"
				/>
			</div>
		</div>

	</div>

	<div v-else :class="$style.loading">
		<MkLoading/>
	</div>

	<!-- チャットとPublishはfixedレイヤーで表示（コンテナのflexレイアウトに含めない） -->
	<XChat
		v-if="roomInfo"
		ref="chatRef"
		:roomId="props.roomId"
		:participants="roomInfo.participants"
	/>
	<XPublish
		v-if="roomInfo"
		ref="publishRef"
		:roomId="props.roomId"
		:canPublish="strokeCount > 0"
		@getCanvasImage="onGetCanvasImage"
	/>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import MkStickyContainer from '@/components/global/MkStickyContainer.vue';
import MkPageHeader from '@/components/global/MkPageHeader.vue';
import MkLoading from '@/pages/_loading_.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useRouter } from '@/router.js';
import { definePage } from '@/page.js';
import * as os from '@/os.js';
import type { RoomInfo, PresenceStatus, ToolType, StrokeData } from './room.types.js';
import { usePaintChatConnection } from './room.network.js';
import type { CanvasEngine } from './room.canvas.js';
import { createCanvasEngine } from './room.canvas.js';
import { downloadWithSteganography } from './room.steganography.js';
import XCanvas from './room.canvas.vue';
import XToolbar from './room.toolbar.vue';
import XChat from './room.chat.vue';
import XPublish from './room.publish.vue';

const props = defineProps<{
	roomId: string;
}>();

const router = useRouter();
const roomInfo = ref<RoomInfo | null>(null);
// マッチング直後は相手も入室しているはずなのでデフォルトはonline
const partnerPresence = ref<PresenceStatus>('online');
const canvasCompRef = ref<InstanceType<typeof XCanvas> | null>(null);
const toolbarRef = ref<InstanceType<typeof XToolbar> | null>(null);
let isEyedropperMode = false;
const chatRef = ref<InstanceType<typeof XChat> | null>(null);
const publishRef = ref<InstanceType<typeof XPublish> | null>(null);
const strokeCount = ref(0);

// 投稿許可の状態管理
const partnerPublishConsent = ref(false);
const isPublished = ref(false);

// ソロモード判定（参加者が1人の場合）
const isSolo = computed(() => {
	if (!roomInfo.value) return false;
	return roomInfo.value.participants.length <= 1;
});

// WebSocket接続
const paintChat = usePaintChatConnection(props.roomId);

// 自分と相手の匿名名
const myName = computed(() => {
	if (!roomInfo.value) return '';
	const me = roomInfo.value.participants.find(p => p.id === roomInfo.value!.myParticipantId);
	return me?.anonymousName ?? '';
});

const partnerName = computed(() => {
	if (!roomInfo.value) return '';
	const partner = roomInfo.value.participants.find(p => p.id !== roomInfo.value!.myParticipantId);
	return partner?.anonymousName ?? '';
});

// キャンバスエンジン（ルーム情報取得後に初期化）
const canvasEngine = ref<CanvasEngine | null>(null);

// ヘッダーアクション
const headerActions = computed(() => []);

// WebSocket再接続時にキャンバス状態を再取得する
paintChat.onReconnected(async () => {
	if (!canvasEngine.value) return;
	try {
		const canvasData = await misskeyApi('paint-chat/canvas' as any, { roomId: props.roomId } as any) as any;
		if (canvasData && (canvasData.strokes?.length > 0 || canvasData.mergedImage)) {
			// キャンバスをクリアしてから再復元（切断中に追加されたストロークも含む）
			canvasEngine.value.clear();
			await canvasEngine.value.restoreStrokes(canvasData.strokes ?? [], canvasData.mergedImage);
		}
	} catch {
		// 復元失敗は無視
	}
});

// リモートストロークの受信
paintChat.on('stroke', (data) => {
	canvasEngine.value?.drawRemoteStroke(data as StrokeData);
});

// リモート描画進行中
paintChat.on('progress', (data) => {
	canvasEngine.value?.drawRemoteProgress(data.participantId, data.points);
});

// リモートアンドゥ
paintChat.on('undone', (data) => {
	canvasEngine.value?.applyRemoteUndo((data as any).strokeId);
});

// チャットメッセージ受信
paintChat.on('message', (data) => {
	chatRef.value?.addMessage(data as any);
});

// リモートキャンバスクリア
paintChat.on('canvasCleared', () => {
	canvasEngine.value?.clear();
});

// 投稿同意フローのイベント
paintChat.on('publishRequested', () => {
	publishRef.value?.onPublishRequested();
});
paintChat.on('publishAgreed', () => {
	// 相手が投稿を許可した
	partnerPublishConsent.value = true;
	publishRef.value?.onPublishAgreed();
});
paintChat.on('publishRejected', () => {
	// 相手が投稿許可を取り消した
	partnerPublishConsent.value = false;
	publishRef.value?.onPublishRejected();
});
paintChat.on('published', () => {
	isPublished.value = true;
	publishRef.value?.onPublished();
});

// 相手の退出通知（明示的な退出）。プレゼンスをofflineにするだけでダイアログは出さない。
paintChat.on('partnerLeft', () => {
	partnerPresence.value = 'offline';
});

// セッション終了通知（サーバーがルームを明示的に終了させた場合のみ）
// 一時的な切断（ダウンロード、タブ切替等）では自動再接続に任せる
paintChat.on('sessionEnded', () => {
	// ログのみ出力。ダイアログは表示せず、ユーザーはそのまま再接続を試みる
	console.info('[PaintChat] Session ended event received, will auto-reconnect if possible.');
});

// プレゼンス更新の受信
paintChat.on('presenceUpdate', (data) => {
	if (data.participantId !== roomInfo.value?.myParticipantId) {
		partnerPresence.value = data.status;
	}
});

// --- キャンバスイベントハンドラ ---
function onStrokeEnd(stroke: StrokeData) {
	paintChat.sendStroke(stroke);
	strokeCount.value++;
}

function onProgress(points: any[]) {
	paintChat.sendProgress(points);
}

function onCursorMove(x: number, y: number) {
	paintChat.sendCursorMove(x, y);
}

function onToolChange(tool: ToolType) {
	isEyedropperMode = tool === 'eyedropper';
	canvasCompRef.value?.setEyedropperMode(isEyedropperMode);
	// 移動/スポイトツールはcanvasEngineには渡さない（描画ツールのみ）
	if (tool !== 'move' && tool !== 'eyedropper') {
		canvasEngine.value?.setState({ currentTool: tool });
	}
}

// チャットの開閉トグル
function onToggleChat() {
	if (chatRef.value?.isOpen) {
		chatRef.value.closeChat();
	} else {
		chatRef.value?.openChat();
	}
}

// スポイト: キャンバスからピクセル色を取得してツールバーに反映
function onEyedrop(color: string) {
	toolbarRef.value?.setColorFromEyedropper(color);
	canvasEngine.value?.setState({ currentColor: color });
}

function onColorChange(color: string) {
	canvasEngine.value?.setState({ currentColor: color });
}

function onWidthChange(width: number) {
	canvasEngine.value?.setState({ currentWidth: width });
}

function onOpacityChange(opacity: number) {
	canvasEngine.value?.setState({ currentOpacity: opacity });
}

function onUndo() {
	const strokeId = canvasEngine.value?.undo();
	if (strokeId) {
		paintChat.sendUndo();
	}
}

function onDownloadAll() {
	const canvas = window.document.querySelector('canvas');
	if (canvas) {
		downloadWithSteganography(canvas, props.roomId, `paintchat-${props.roomId}.png`);
	}
}

// 自分のストロークのみダウンロード（ステガノグラフィ付き: FR-037）
function onDownloadMine() {
	if (!canvasEngine.value) return;
	const dataUrl = canvasEngine.value.toMyStrokesDataURL();
	downloadFromDataUrl(dataUrl, `paintchat-mine-${props.roomId}.png`);
}

// data URLから一時canvasを作成してステガノグラフィ付きでダウンロードする
function downloadFromDataUrl(dataUrl: string, filename: string) {
	const img = new Image();
	img.onload = () => {
		const tmpCanvas = window.document.createElement('canvas');
		tmpCanvas.width = img.width;
		tmpCanvas.height = img.height;
		const tmpCtx = tmpCanvas.getContext('2d')!;
		tmpCtx.drawImage(img, 0, 0);
		downloadWithSteganography(tmpCanvas, props.roomId, filename);
	};
	img.src = dataUrl;
}

// 自分の絵のみbot経由で匿名投稿
async function onPublishMyArt() {
	if (!canvasEngine.value) return;

	const confirm = await os.confirm({
		type: 'question',
		text: '自分が描いた部分だけをbot経由で匿名投稿しますか？',
	});
	if (confirm.canceled) return;

	const dataUrl = canvasEngine.value.toMyStrokesDataURL();

	try {
		await misskeyApi('paint-chat/publish/my-art' as any, {
			roomId: props.roomId,
			imageBase64: dataUrl,
		} as any);
		await os.alert({ type: 'success', text: '投稿しました。' });
	} catch {
		await os.alert({ type: 'error', text: '投稿に失敗しました。' });
	}
}

// 投稿同意フローからキャンバス画像を要求された時のハンドラ
function onGetCanvasImage() {
	if (canvasEngine.value) {
		const dataUrl = canvasEngine.value.toDataURL('image/png');
		publishRef.value?.receiveCanvasImage(dataUrl);
	}
}

// 投稿許可の自分の状態
const myPublishConsent = ref(false);

// 投稿許可トグル: サーバー応答後にUI状態を更新（UI/サーバー状態の不整合を防止）
async function onPublishConsent(consent: boolean) {
	try {
		if (consent) {
			await misskeyApi('paint-chat/publish/agree' as any, { roomId: props.roomId } as any);
		} else {
			await misskeyApi('paint-chat/publish/reject' as any, { roomId: props.roomId } as any);
		}
		// サーバー応答成功後にUI状態を更新
		myPublishConsent.value = consent;
	} catch {
		// 失敗時はUI状態を変更しない（サーバーとの整合性を維持）
	}
}

// 投稿リクエスト（ツールバーの投稿パネルから呼ばれる。両者許可済みの場合のみ実行可能。）
async function onPublishRequest() {
	publishRef.value?.onPublishRequested();
}

// 通報処理
async function reportRoom() {
	const confirm = await os.confirm({
		type: 'warning',
		text: '相手を通報しますか？通報した相手とは今後マッチングされなくなります。',
	});
	if (confirm.canceled) return;

	try {
		await misskeyApi('paint-chat/report' as any, { roomId: props.roomId } as any);
		await os.alert({ type: 'success', text: '通報しました。' });
	} catch {
		await os.alert({ type: 'error', text: '通報に失敗しました。' });
	}
}

// リソースを完全に破棄する（退出・ページ離脱共通、二重呼び出し防止）
let cleaned = false;

function cleanup() {
	if (cleaned) return;
	cleaned = true;
	// プレゼンスofflineを送信してからWebSocketを切断
	paintChat.sendPresence('offline');
	paintChat.disconnect();
	// visibilitychangeリスナーを解除
	window.document.removeEventListener('visibilitychange', onVisibilityChange);
	// キャンバスエンジンを破棄
	canvasEngine.value?.dispose();
	canvasEngine.value = null;
}

// 退出処理
async function leaveRoom() {
	const confirm = await os.confirm({
		type: 'warning',
		text: '退出しますか？',
	});
	if (confirm.canceled) return;

	// リソースを先に破棄
	cleanup();

	try {
		await misskeyApi('paint-chat/leave' as any, { roomId: props.roomId } as any);
	} catch {
		// 退出通知に失敗しても画面遷移は続行
	}
	(router as any).push('/paintchat');
}

// ルーム情報取得
onMounted(async () => {
	try {
		const res = await misskeyApi('paint-chat/room' as any, { roomId: props.roomId } as any) as any;

		// セッション終了済みルームの場合は通知して戻す
		if (res.room.status === 'ended') {
			await os.alert({
				type: 'info',
				text: 'このルームは終了しました。',
			});
			(router as any).push('/paintchat');
			return;
		}

		roomInfo.value = res;

		// キャンバスエンジン初期化
		canvasEngine.value = createCanvasEngine(res.myParticipantId);

		// リロード時のキャンバス復元: Redisからストロークデータを取得して再描画
		try {
			const canvasData = await misskeyApi('paint-chat/canvas' as any, { roomId: props.roomId } as any) as any;
			if (canvasData && (canvasData.strokes?.length > 0 || canvasData.mergedImage)) {
				// canvasEngine.initが完了するまで少し待つ（nextTick）
				await nextTick();
				await canvasEngine.value?.restoreStrokes(canvasData.strokes ?? [], canvasData.mergedImage);
			}
		} catch {
			// 復元失敗は無視（新規セッションとして開始）
		}

		// WebSocket接続開始
		paintChat.connect();

		// Page Visibility APIでプレゼンス状態を送信
		// 初回接続のonline通知はサーバー側のPaintChatChannel.init()で自動送信される
		window.document.addEventListener('visibilitychange', onVisibilityChange);
	} catch {
		// アクセス拒否またはルーム不存在
		await os.alert({
			type: 'error',
			text: 'このルームにアクセスできません。',
		});
		(router as any).push('/paintchat');
	}
});

// プレゼンス判定: ページが表示されているかつこの部屋のルートにいるかどうか
function onVisibilityChange() {
	const isOnRoomPage = window.location.pathname.includes(`/paintchat/${props.roomId}`);
	if (window.document.hidden || !isOnRoomPage) {
		paintChat.sendPresence('offline');
	} else {
		paintChat.sendPresence('online');
	}
}

onUnmounted(() => {
	// ページ離脱時にもリソースを完全破棄
	cleanup();
});

// ウィジェット非表示はdefinePageのneedWideAreaで制御（universal.vueが参照）

definePage(() => ({
	title: 'ランダム絵チャット',
	icon: 'ti ti-brush',
	needWideArea: true, // ウィジェットペインを非表示にしてキャンバス領域を最大化
}));
</script>

<style lang="scss" module>
// Misskeyヘッダー + モバイルナビバーを考慮した高さ。overflow: hiddenで内部スクロール防止。
.container {
	display: flex;
	flex-direction: column;
	height: calc(100dvh - var(--MI-globalHeaderHeight, 50px) - env(safe-area-inset-bottom, 0px));
	overflow: hidden;
}

.roomHeader {
	padding: 8px 16px;
	border-bottom: 1px solid var(--divider);
	flex-shrink: 0;
}

.participants {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 0.95em;
}

.myName {
	font-weight: bold;
	color: var(--accent);
}

.vs {
	color: var(--fgTransparent);
	font-size: 0.85em;
}

.partnerName {
	font-weight: bold;
}

.presenceOnline {
	font-size: 0.75em;
	color: #4caf50;
	margin-left: 6px;
	display: inline-flex;
	align-items: center;
	gap: 3px;
}

.presenceDot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: #4caf50;
	display: inline-block;
	animation: presencePulse 2s ease-in-out infinite;
}

.presenceOffline {
	font-size: 0.75em;
	color: #999;
	margin-left: 6px;
	display: inline-flex;
	align-items: center;
	gap: 3px;
}

.presenceDotOff {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: #999;
	display: inline-block;
}

@keyframes presencePulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}

.roomInfo {
	margin-top: 4px;
}

.dataNotice {
	font-size: 0.75em;
	color: var(--fgTransparent);
}

// キャンバスとサイドバーのコンテナ
.canvasArea {
	flex: 1;
	position: relative;
	overflow: hidden;
}

// キャンバス本体（サイドバー44px分左オフセット）
.canvasInner {
	position: absolute;
	left: 44px;
	top: 0;
	right: 0;
	bottom: 0;
	overflow: hidden;
}

.loading {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 400px;
}
</style>
