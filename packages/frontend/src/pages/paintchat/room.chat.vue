<template>
<!-- テキストチャット: 開閉可能、未読点滅、お題・サイコロボタン付き。モバイルではフルスクリーン切替。 -->
<div :class="$style.chatWrapper">
	<!-- チャットトグルボタン（閉じている時に表示） -->
	<button
		v-if="!isOpen"
		:class="[$style.chatToggle, hasUnread ? $style.chatToggleUnread : '']"
		@click="openChat"
	>
		<i class="ti ti-message-circle"></i>
		<span v-if="hasUnread" :class="$style.unreadBadge">!</span>
	</button>

	<!-- チャットパネル（開いている時） -->
	<div v-if="isOpen" :class="$style.chatPanel">
		<!-- ヘッダー -->
		<div :class="$style.chatHeader">
			<span>チャット</span>
			<button :class="$style.closeBtn" @click="closeChat">
				<i class="ti ti-x"></i>
			</button>
		</div>

		<!-- メッセージ一覧 -->
		<div ref="messagesRef" :class="$style.messageList">
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
					<span :class="$style.systemIcon"><i class="ti ti-bulb"></i></span>
					<span :class="$style.msgContent">お題: {{ msg.content }}</span>
				</template>
				<template v-else-if="msg.type === 'dice'">
					<span :class="$style.systemIcon"><i class="ti ti-dice"></i></span>
					<span :class="$style.msgContent">
						{{ getParticipantName(msg.participantId) }} が {{ msg.content }} を出した
					</span>
				</template>
				<template v-else>
					<span :class="$style.systemIcon"><i class="ti ti-info-circle"></i></span>
					<span :class="$style.msgContent">{{ msg.content }}</span>
				</template>
			</div>
		</div>

		<!-- 入力エリア -->
		<div :class="$style.inputArea">
			<div :class="$style.actionButtons">
				<button :class="$style.actionBtn" title="お題" @click="requestTopic">
					<i class="ti ti-bulb"></i>
				</button>
				<button :class="$style.actionBtn" title="サイコロ" @click="requestDice">
					<i class="ti ti-dice"></i>
				</button>
			</div>
			<input
				v-model="inputText"
				:class="$style.textInput"
				type="text"
				placeholder="メッセージを入力..."
				maxlength="500"
				@keydown.enter="sendMessage"
			>
			<button :class="$style.sendBtn" :disabled="!inputText.trim()" @click="sendMessage">
				<i class="ti ti-send"></i>
			</button>
		</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { ref, nextTick, watch } from 'vue';
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

// チャットを開く
function openChat() {
	isOpen.value = true;
	hasUnread.value = false;
	emit('open');
	// メッセージ一覧を取得
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
		// 送信失敗: 入力テキストを復元し、エラーを表示
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
		// チャットが閉じていたら未読フラグを立てる
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

// 外部公開
defineExpose({ addMessage });
</script>

<style lang="scss" module>
.chatWrapper {
	position: relative;
}

.chatToggle {
	position: fixed;
	bottom: 120px;
	right: 16px;
	width: 48px;
	height: 48px;
	border-radius: 50%;
	background: var(--accent);
	color: white;
	border: none;
	cursor: pointer;
	font-size: 22px;
	display: flex;
	align-items: center;
	justify-content: center;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
	z-index: 100;
}

// 未読時のゆっくり点滅アニメーション
.chatToggleUnread {
	animation: slowPulse 2s ease-in-out infinite;
}

.unreadBadge {
	position: absolute;
	top: -2px;
	right: -2px;
	width: 18px;
	height: 18px;
	border-radius: 50%;
	background: #ff4444;
	color: white;
	font-size: 11px;
	display: flex;
	align-items: center;
	justify-content: center;
}

.chatPanel {
	position: fixed;
	bottom: 0;
	left: 0;
	right: 0;
	top: 0;
	background: var(--bg);
	z-index: 200;
	display: flex;
	flex-direction: column;

	@media (min-width: 768px) {
		position: absolute;
		top: auto;
		height: 400px;
		border-top: 1px solid var(--divider);
	}
}

.chatHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 16px;
	border-bottom: 1px solid var(--divider);
	font-weight: bold;
	flex-shrink: 0;
}

.closeBtn {
	background: transparent;
	border: none;
	cursor: pointer;
	font-size: 18px;
	color: var(--fg);
	padding: 4px;
}

.messageList {
	flex: 1;
	overflow-y: auto;
	padding: 12px 16px;
}

.message {
	margin-bottom: 8px;
	font-size: 0.95em;
	line-height: 1.5;
}

.systemMessage {
	color: var(--fgTransparent);
	font-size: 0.85em;
}

.msgSender {
	font-weight: bold;
	margin-right: 6px;
}

.msgContent {
	word-break: break-word;
}

.systemIcon {
	margin-right: 4px;
}

.inputArea {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	border-top: 1px solid var(--divider);
	flex-shrink: 0;
}

.actionButtons {
	display: flex;
	gap: 4px;
}

.actionBtn {
	width: 36px;
	height: 36px;
	border-radius: 8px;
	border: none;
	background: transparent;
	cursor: pointer;
	font-size: 18px;
	color: var(--fg);
	display: flex;
	align-items: center;
	justify-content: center;

	&:hover {
		background: var(--bgSecondary);
	}
}

.textInput {
	flex: 1;
	padding: 8px 12px;
	border-radius: 20px;
	border: 1px solid var(--divider);
	background: var(--bg);
	color: var(--fg);
	font-size: 0.95em;
	outline: none;

	&:focus {
		border-color: var(--accent);
	}
}

.sendBtn {
	width: 36px;
	height: 36px;
	border-radius: 50%;
	border: none;
	background: var(--accent);
	color: white;
	cursor: pointer;
	font-size: 16px;
	display: flex;
	align-items: center;
	justify-content: center;

	&:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
}

@keyframes slowPulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}
</style>
