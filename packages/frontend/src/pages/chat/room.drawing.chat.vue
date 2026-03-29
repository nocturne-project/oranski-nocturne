<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only

お絵描きタブ内チャットオーバーレイ
paintchatのroom.chat.vueを移植。既存のchatRoomチャネルのメッセージを表示・送信。
-->

<template>
<div :class="$style.chatWrapper">
	<!-- チャットパネル（開いている時） -->
	<div v-if="isOpen" :class="$style.chatPanel">
		<!-- ヘッダー -->
		<div :class="$style.chatHeader">
			<span :class="$style.chatHeaderTitle">チャット</span>
			<button :class="$style.closeBtn" @click="closeChat">閉じる</button>
		</div>

		<!-- メッセージ一覧 -->
		<div ref="messagesRef" :class="$style.messageList">
			<div v-if="messages.length === 0" :class="$style.emptyMessage">
				まだメッセージはありません
			</div>
			<div
				v-for="msg in messages"
				:key="msg.id"
				:class="$style.message"
			>
				<span :class="$style.msgSender">{{ msg.userName }}</span>
				<span :class="$style.msgContent">{{ msg.content }}</span>
				<span :class="$style.msgTimestamp">{{ formatTime(msg.createdAt) }}</span>
			</div>
		</div>

		<!-- 入力エリア -->
		<div :class="$style.inputArea">
			<div :class="$style.inputRow">
				<input
					v-model="inputText"
					:class="$style.textInput"
					type="text"
					placeholder="メッセージを入力..."
					maxlength="500"
					@keydown.enter="sendMessage"
				>
				<button :class="$style.sendBtn" :disabled="!inputText.trim()" @click="sendMessage">送信</button>
			</div>
		</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { ref, nextTick } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';

// メッセージの型（グループチャットのメッセージ形式）
interface DrawingChatMessage {
	id: string;
	userName: string;
	content: string;
	createdAt: string;
}

const props = defineProps<{
	connection: any; // WebSocket connection
	myUserId: string;
	myUserName: string;
	roomId?: string; // ルームチャット
	userId?: string; // DM
}>();

const isOpen = ref(false);
const hasUnread = ref(false);
const messages = ref<DrawingChatMessage[]>([]);
const inputText = ref('');
const messagesRef = ref<HTMLDivElement | null>(null);

// タイムスタンプを HH:MM 形式にフォーマット
function formatTime(isoString: string): string {
	const d = new Date(isoString);
	return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// チャットを開く（過去メッセージを読み込み）
async function openChat() {
	isOpen.value = true;
	hasUnread.value = false;
	await loadMessages();
}

// チャットを閉じる
function closeChat() {
	isOpen.value = false;
}

// 過去メッセージをAPIから読み込み
async function loadMessages() {
	try {
		let apiMessages: any[] = [];
		if (props.roomId) {
			apiMessages = await misskeyApi('chat/messages/room-timeline', {
				roomId: props.roomId,
				limit: 50,
			}) as any;
		} else if (props.userId) {
			apiMessages = await misskeyApi('chat/messages/user-timeline', {
				userId: props.userId,
				limit: 50,
			}) as any;
		}

		// APIレスポンスをDrawingChatMessage形式に変換
		// fromUserがない場合はfromUserIdで判定
		const converted: DrawingChatMessage[] = apiMessages.map((msg: any) => ({
			id: msg.id,
			userName: msg.fromUser?.name || msg.fromUser?.username
				|| (msg.fromUserId === props.myUserId ? props.myUserName : ''),
			content: msg.text || '',
			createdAt: msg.createdAt,
		})).reverse(); // APIは新しい順なので逆順にする

		messages.value = converted;
		await nextTick();
		scrollToBottom();
	} catch {
		// 読み込み失敗時は空のまま
	}
}

// メッセージを送信（API経由でMessages側にも反映）
async function sendMessage() {
	const text = inputText.value.trim();
	if (!text) return;

	inputText.value = '';

	try {
		if (props.roomId) {
			// ルームチャット: API経由で送信（DB保存＋WebSocket配信）
			await misskeyApi('chat/messages/create', {
				roomId: props.roomId,
				text,
			} as any);
		} else if (props.userId) {
			// DM: API経由で送信
			await misskeyApi('chat/messages/create', {
				userId: props.userId,
				text,
			} as any);
		}
		// メッセージはWebSocketのmessageイベントで受信してaddMessageされる
	} catch {
		// 送信失敗時は入力欄に戻す
		inputText.value = text;
	}
}

// 外部からメッセージを追加する（WebSocket経由）
function addMessage(msg: DrawingChatMessage) {
	// 重複チェック
	if (messages.value.some(m => m.id === msg.id)) return;

	messages.value.push(msg);

	// 最大100件保持
	if (messages.value.length > 100) {
		messages.value.shift();
	}

	if (!isOpen.value) {
		hasUnread.value = true;
	} else {
		nextTick(() => scrollToBottom());
	}
}

function scrollToBottom() {
	if (messagesRef.value) {
		messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
	}
}

defineExpose({ addMessage, openChat, closeChat, isOpen, hasUnread });
</script>

<style lang="scss" module>
.chatWrapper {
	position: absolute;
	bottom: 8px;
	right: 8px;
	z-index: 50;
}

// チャットパネル（キャンバス右下にオーバーレイ、半透明）
.chatPanel {
	width: 320px;
	max-height: 400px;
	background: color-mix(in srgb, var(--MI_THEME-panel) 92%, transparent);
	backdrop-filter: blur(8px);
	border-radius: 12px;
	border: 1px solid var(--MI_THEME-divider);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	display: flex;
	flex-direction: column;
	overflow: hidden;

	@media (max-width: 700px) {
		width: 260px;
		max-height: 300px;
	}
}

.chatHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 12px;
	border-bottom: 1px solid var(--MI_THEME-divider);
	flex-shrink: 0;
}

.chatHeaderTitle {
	font-weight: bold;
	font-size: 13px;
	color: var(--MI_THEME-fg);
}

.closeBtn {
	padding: 4px 10px;
	border-radius: 4px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
	cursor: pointer;
	font-size: 12px;
	color: var(--MI_THEME-fg);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.messageList {
	flex: 1;
	overflow-y: auto;
	padding: 8px 12px;
	min-height: 100px;
}

.emptyMessage {
	text-align: center;
	color: var(--MI_THEME-fg);
	opacity: 0.5;
	padding: 20px 0;
	font-size: 13px;
}

.message {
	margin-bottom: 6px;
	font-size: 13px;
	line-height: 1.5;
	color: var(--MI_THEME-fg);
}

.msgSender {
	font-weight: bold;
	margin-right: 4px;
	color: var(--MI_THEME-accent);
}

.msgContent {
	word-break: break-word;
}

.msgTimestamp {
	margin-left: 4px;
	font-size: 10px;
	color: var(--MI_THEME-fg);
	opacity: 0.4;
	white-space: nowrap;
}

.inputArea {
	padding: 8px;
	border-top: 1px solid var(--MI_THEME-divider);
	flex-shrink: 0;
}

.inputRow {
	display: flex;
	gap: 6px;
}

.textInput {
	flex: 1;
	padding: 6px 10px;
	border-radius: 6px;
	border: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-bg);
	color: var(--MI_THEME-fg);
	font-size: 13px;
	outline: none;

	&:focus {
		border-color: var(--MI_THEME-accent);
	}
}

.sendBtn {
	padding: 6px 12px;
	border-radius: 6px;
	border: none;
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-fgOnAccent);
	cursor: pointer;
	font-size: 13px;
	font-weight: bold;

	&:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
}
</style>
