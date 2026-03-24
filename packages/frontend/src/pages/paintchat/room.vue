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
				<span :class="$style.vs">vs</span>
				<span :class="$style.partnerName">
					{{ partnerName }}
					<span v-if="partnerPresence === 'online'" :class="$style.presenceOnline">入室中</span>
					<span v-else :class="$style.presenceOffline">退室中</span>
				</span>
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
				@toolChange="onToolChange"
				@colorChange="onColorChange"
				@widthChange="onWidthChange"
				@opacityChange="onOpacityChange"
				@undo="onUndo"
				@zoomIn="canvasCompRef?.zoomIn()"
				@zoomOut="canvasCompRef?.zoomOut()"
				@zoomReset="canvasCompRef?.zoomReset()"
				@downloadAll="onDownloadAll"
				@downloadMine="onDownloadMine"
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
				/>
			</div>
		</div>

		<!-- 下部バー（通報・退出ボタン、テキスト付き） -->
		<div :class="$style.bottomBar">
			<button :class="$style.reportButton" @click="reportRoom">通報</button>
			<div :class="$style.bottomSpacer"></div>
			<button :class="$style.leaveButton" @click="leaveRoom">退出する</button>
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
import { ref, computed, onMounted, onUnmounted } from 'vue';
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
const chatRef = ref<InstanceType<typeof XChat> | null>(null);
const publishRef = ref<InstanceType<typeof XPublish> | null>(null);
const strokeCount = ref(0);

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
	publishRef.value?.onPublishAgreed();
});
paintChat.on('publishRejected', () => {
	publishRef.value?.onPublishRejected();
});
paintChat.on('published', () => {
	publishRef.value?.onPublished();
});

// 相手の退出通知
paintChat.on('partnerLeft', async () => {
	await os.alert({
		type: 'info',
		text: '相手が退出しました。',
	});
});

// セッション終了通知
paintChat.on('sessionEnded', async (data) => {
	await os.alert({
		type: 'info',
		text: 'セッションが終了しました。',
	});
	(router as any).push('/paintchat');
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
	canvasEngine.value?.setState({ currentTool: tool });
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

	// 一時canvasに描画してステガノグラフィを埋め込む
	const img = new Image();
	img.onload = () => {
		const tmpCanvas = window.document.createElement('canvas');
		tmpCanvas.width = img.width;
		tmpCanvas.height = img.height;
		const tmpCtx = tmpCanvas.getContext('2d')!;
		tmpCtx.drawImage(img, 0, 0);
		downloadWithSteganography(tmpCanvas, props.roomId, `paintchat-mine-${props.roomId}.png`);
	};
	img.src = dataUrl;
}

// 投稿同意フローからキャンバス画像を要求された時のハンドラ
function onGetCanvasImage() {
	if (canvasEngine.value) {
		const dataUrl = canvasEngine.value.toDataURL('image/png');
		publishRef.value?.receiveCanvasImage(dataUrl);
	}
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

// 退出処理
async function leaveRoom() {
	const confirm = await os.confirm({
		type: 'warning',
		text: '退出しますか？',
	});
	if (confirm.canceled) return;

	try {
		await misskeyApi('paint-chat/leave' as any, { roomId: props.roomId } as any);
	} catch {
		// 退出通知に失敗。相手にはまだ入室中と表示される可能性がある。
		await os.alert({ type: 'warning', text: '退出の通知に失敗しました。相手にはまだ入室中と表示されている可能性があります。' });
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

		// WebSocket接続開始
		paintChat.connect();

		// Page Visibility APIでプレゼンス状態を送信
		window.document.addEventListener('visibilitychange', onVisibilityChange);
		paintChat.sendPresence('online');
	} catch {
		// アクセス拒否またはルーム不存在
		await os.alert({
			type: 'error',
			text: 'このルームにアクセスできません。',
		});
		(router as any).push('/paintchat');
	}
});

function onVisibilityChange() {
	if (window.document.hidden) {
		paintChat.sendPresence('offline');
	} else {
		paintChat.sendPresence('online');
	}
}

onUnmounted(() => {
	window.document.removeEventListener('visibilitychange', onVisibilityChange);
});

definePage(() => ({
	title: 'ランダム絵チャット',
	icon: 'ti ti-brush',
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
	margin-left: 4px;
}

.presenceOffline {
	font-size: 0.75em;
	color: #999;
	margin-left: 4px;
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

.bottomBar {
	display: flex;
	align-items: center;
	padding: 8px 16px;
	border-top: 1px solid var(--divider);
	background: var(--panel);
	flex-shrink: 0;
}

.bottomSpacer {
	flex: 1;
}

.reportButton {
	padding: 6px 14px;
	border-radius: 6px;
	border: 1px solid var(--divider);
	background: transparent;
	cursor: pointer;
	color: #ff6b6b;
	font-size: 13px;

	&:hover {
		background: rgba(255, 107, 107, 0.1);
	}
}

.leaveButton {
	padding: 6px 16px;
	border-radius: 6px;
	border: 1px solid var(--divider);
	background: transparent;
	cursor: pointer;
	color: var(--fg);
	font-size: 13px;

	&:hover {
		background: var(--bg);
	}
}

.loading {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 400px;
}
</style>
