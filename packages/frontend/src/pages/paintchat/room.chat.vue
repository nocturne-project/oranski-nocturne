<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- テキストチャット: 開閉可能、未読点滅、お題・サイコロボタン付き -->
<div :class="$style.chatWrapper">
	<!-- チャットトグルボタン（閉じている時のみ表示） -->
	<button
		v-if="!isOpen"
		:class="[$style.chatToggle, hasUnread ? $style.chatToggleUnread : '']"
		@click="openChat"
	>
		チャット
		<span v-if="hasUnread" :class="$style.unreadDot"></span>
	</button>

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
				:class="[$style.message, msg.type !== 'text' ? $style.systemMessage : '']"
			>
				<template v-if="msg.type === 'text'">
					<span :class="$style.msgSender">{{ getParticipantName(msg.participantId) }}</span>
					<span :class="$style.msgContent">{{ msg.content }}</span>
				</template>
				<template v-else-if="msg.type === 'topic'">
					<span :class="$style.msgContent">お題: {{ msg.content }}</span>
				</template>
				<template v-else-if="msg.type === 'dice'">
					<span :class="$style.msgContent">
						{{ getParticipantName(msg.participantId) }} がサイコロで {{ msg.content }} を出した
					</span>
				</template>
				<template v-else>
					<span :class="$style.msgContent">{{ msg.content }}</span>
				</template>
			</div>
		</div>

		<!-- 入力エリア -->
		<div :class="$style.inputArea">
			<div :class="$style.actionButtons">
				<button :class="$style.actionBtn" @click="requestTopic">お題</button>
				<button :class="$style.actionBtn" @click="requestDice">サイコロ</button>
			</div>
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
import type { ChatMessage, Participant } from './room.types.js';

const props = defineProps<{
	roomId: string;
	participants: Participant[];
}>();

const emit = defineEmits<{
	(e: 'open'): void;
	(e: 'close'): void;
}>();

const isOpen = ref(false);
const hasUnread = ref(false);
const messages = ref<ChatMessage[]>([]);
const inputText = ref('');
const messagesRef = ref<HTMLDivElement | null>(null);

// 参加者名を取得する
function getParticipantName(participantId: string | null): string {
	if (participantId == null) return 'システム';
	const p = props.participants.find(p => p.id === participantId);
	return p?.anonymousName ?? '???';
}

// システムメッセージをローカル追加するヘルパー
function addSystemMessage(content: string) {
	messages.value.push({
		id: `local-${Date.now()}`,
		participantId: null,
		type: 'system',
		content,
		createdAt: new Date().toISOString(),
	});
}

// チャットを開く
function openChat() {
	isOpen.value = true;
	hasUnread.value = false;
	emit('open');
	loadMessages();
}

// チャットを閉じる
function closeChat() {
	isOpen.value = false;
	emit('close');
}

// メッセージ一覧を取得する
async function loadMessages() {
	try {
		const res = await misskeyApi('paint-chat/messages' as any, { roomId: props.roomId } as any) as any;
		messages.value = res.messages;
		await nextTick();
		scrollToBottom();
	} catch {
		addSystemMessage('メッセージの読み込みに失敗しました');
	}
}

// メッセージを送信する
async function sendMessage() {
	const text = inputText.value.trim();
	if (!text) return;

	inputText.value = '';
	try {
		await misskeyApi('paint-chat/message' as any, {
			roomId: props.roomId,
			content: text,
		} as any);
	} catch {
		inputText.value = text;
		addSystemMessage('メッセージの送信に失敗しました');
	}
}

// お題をリクエストする
async function requestTopic() {
	try {
		await misskeyApi('paint-chat/topic' as any, { roomId: props.roomId } as any);
	} catch (e: any) {
		if (e.code === 'NO_TOPICS_CONFIGURED') {
			addSystemMessage('お題が設定されていません');
		} else if (e.code === 'TOPIC_ALREADY_USED') {
			addSystemMessage('お題は1部屋につき1回までです');
		} else {
			addSystemMessage('お題の取得に失敗しました');
		}
	}
}

// サイコロを振る
async function requestDice() {
	try {
		await misskeyApi('paint-chat/dice' as any, { roomId: props.roomId } as any);
	} catch {
		addSystemMessage('サイコロの送信に失敗しました');
	}
}

// 外部からメッセージを追加する（WebSocket経由）
function addMessage(msg: ChatMessage) {
	messages.value.push(msg);
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

defineExpose({ addMessage });
</script>

<style lang="scss" module>
.chatWrapper {
	position: relative;
}

// チャットトグルボタン（テキスト付き）
.chatToggle {
	position: fixed;
	bottom: 80px;
	right: 16px;
	padding: 8px 16px;
	border-radius: 20px;
	background: var(--accent);
	color: white;
	border: none;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
	z-index: 9000;
	display: flex;
	align-items: center;
	gap: 6px;
}

// 未読時のゆっくり点滅
.chatToggleUnread {
	animation: slowPulse 2s ease-in-out infinite;
}

.unreadDot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: #ff4444;
}

// チャットパネル（Misskeyヘッダーの下から全画面表示、確実に不透過）
.chatPanel {
	position: fixed;
	bottom: 0;
	left: 0;
	right: 0;
	top: var(--MI-globalHeaderHeight, 50px);
	background: var(--bg, #1a1a2e);
	z-index: 10000;
	display: flex;
	flex-direction: column;
}

.chatHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 16px;
	border-bottom: 1px solid var(--divider);
	background: var(--header, var(--bg, #1a1a2e));
	flex-shrink: 0;
}

.chatHeaderTitle {
	font-weight: bold;
	font-size: 16px;
}

// 閉じるボタン（テキスト）
.closeBtn {
	padding: 6px 14px;
	border-radius: 6px;
	border: 1px solid var(--divider);
	background: var(--panel);
	cursor: pointer;
	font-size: 14px;
	color: var(--fg);

	&:hover {
		background: var(--bg);
	}
}

.messageList {
	flex: 1;
	overflow-y: auto;
	padding: 12px 16px;
	background: var(--bg, #1a1a2e);
}

.emptyMessage {
	text-align: center;
	color: var(--fgTransparent);
	padding: 40px 0;
	font-size: 14px;
}

.message {
	margin-bottom: 8px;
	font-size: 14px;
	line-height: 1.6;
}

.systemMessage {
	color: var(--fgTransparent);
	font-size: 13px;
	font-style: italic;
}

.msgSender {
	font-weight: bold;
	margin-right: 6px;
}

.msgContent {
	word-break: break-word;
}

.inputArea {
	padding: 8px 12px;
	border-top: 1px solid var(--divider);
	background: var(--bg, #1a1a2e);
	flex-shrink: 0;
}

// アクションボタン（テキスト付き）
.actionButtons {
	display: flex;
	gap: 8px;
	margin-bottom: 8px;
}

.actionBtn {
	padding: 6px 14px;
	border-radius: 16px;
	border: 1px solid var(--divider);
	background: var(--panel);
	cursor: pointer;
	font-size: 13px;
	color: var(--fg);

	&:hover {
		background: var(--bg);
	}
}

.inputRow {
	display: flex;
	gap: 8px;
}

.textInput {
	flex: 1;
	padding: 8px 12px;
	border-radius: 8px;
	border: 1px solid var(--divider);
	background: var(--bg);
	color: var(--fg);
	font-size: 14px;
	outline: none;

	&:focus {
		border-color: var(--accent);
	}
}

// 送信ボタン（テキスト）
.sendBtn {
	padding: 8px 16px;
	border-radius: 8px;
	border: none;
	background: var(--accent);
	color: white;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;

	&:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
}

@keyframes slowPulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}
</style>
