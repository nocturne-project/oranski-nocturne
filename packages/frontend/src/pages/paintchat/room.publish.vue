<template>
<!-- 投稿同意フロー: 同意ボタン、品質ガード、一言メッセージ入力 -->
<div :class="$style.publishWrapper">
	<!-- 投稿済み -->
	<div v-if="isPublished" :class="$style.publishedBadge">
		<i class="ti ti-check"></i> 投稿済み
	</div>

	<!-- 品質ガード: ストロークが不十分 -->
	<div v-else-if="!canPublish" :class="$style.notReady">
		もう少し描いてから投稿しましょう
	</div>

	<!-- 一言メッセージ入力中 -->
	<div v-else-if="phase === 'message'" :class="$style.messagePhase">
		<div :class="$style.messageBox">
			<p>一言メッセージを添えてください（100文字以内）</p>
			<input
				v-model="myMessage"
				:class="$style.messageInput"
				type="text"
				maxlength="100"
				placeholder="一言メッセージ..."
			>
			<div :class="$style.messageActions">
				<button class="_buttonPrimary" :class="$style.confirmBtn" @click="submitMessage">投稿を確定</button>
				<button :class="$style.cancelBtn" @click="cancelPublish">キャンセル</button>
			</div>
		</div>
	</div>

	<!-- 同意待ち -->
	<div v-else-if="phase === 'waiting'" :class="$style.waitingBadge">
		<i class="ti ti-clock"></i> 相手の同意を待っています...
	</div>

	<!-- 同意ボタン -->
	<button
		v-else
		:class="$style.agreeBtn"
		:disabled="!canPublish"
		@click="requestPublish"
	>
		<i class="ti ti-share"></i> 作品を投稿する
	</button>
</div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';

const props = defineProps<{
	roomId: string;
	canPublish: boolean;
}>();

const phase = ref<'idle' | 'waiting' | 'message'>('idle');
const isPublished = ref(false);
const myMessage = ref('');

// 投稿同意リクエスト
async function requestPublish() {
	try {
		const res = await misskeyApi('paint-chat/publish/agree' as any, { roomId: props.roomId } as any) as any;
		if (res.status === 'both_agreed') {
			phase.value = 'message';
		} else {
			phase.value = 'waiting';
		}
	} catch (e: any) {
		if (e.code === 'ALREADY_PUBLISHED') {
			isPublished.value = true;
		} else if (e.code === 'BOT_NOT_CONFIGURED') {
			os.alert({ type: 'error', text: '現在この機能は利用できません' });
		} else if (e.code === 'CANVAS_NOT_READY') {
			os.alert({ type: 'warning', text: 'もう少し描いてから投稿しましょう' });
		}
	}
}

// 一言メッセージ送信＆投稿確定
async function submitMessage() {
	try {
		await misskeyApi('paint-chat/publish/message' as any, {
			roomId: props.roomId,
			message: myMessage.value,
		} as any);
		isPublished.value = true;
		phase.value = 'idle';
	} catch {
		os.alert({ type: 'error', text: '投稿に失敗しました' });
	}
}

// キャンセル
async function cancelPublish() {
	try {
		await misskeyApi('paint-chat/publish/reject' as any, { roomId: props.roomId } as any);
	} catch {
		// ignore
	}
	phase.value = 'idle';
}

// 外部から状態変更する（WebSocket経由）
function onPublishRequested() {
	// 相手が同意リクエストを送ってきた場合、自分も同意するか確認
	os.confirm({
		type: 'question',
		text: '相手が作品の投稿を提案しています。同意しますか？',
	}).then(async (result) => {
		if (result.canceled) {
			await misskeyApi('paint-chat/publish/reject' as any, { roomId: props.roomId } as any).catch(() => {});
			return;
		}
		try {
			const res = await misskeyApi('paint-chat/publish/agree' as any, { roomId: props.roomId } as any) as any;
			if (res.status === 'both_agreed') {
				phase.value = 'message';
			}
		} catch {
			// ignore
		}
	});
}

function onPublishAgreed() {
	phase.value = 'message';
}

function onPublishRejected() {
	phase.value = 'idle';
	os.alert({ type: 'info', text: '相手が投稿を拒否しました' });
}

function onPublished() {
	isPublished.value = true;
	phase.value = 'idle';
}

defineExpose({ onPublishRequested, onPublishAgreed, onPublishRejected, onPublished });
</script>

<style lang="scss" module>
.publishWrapper {
	padding: 8px 16px;
}

.publishedBadge {
	text-align: center;
	color: #4caf50;
	font-size: 0.9em;
	padding: 6px;
}

.notReady {
	text-align: center;
	color: var(--fgTransparent);
	font-size: 0.85em;
	padding: 6px;
}

.waitingBadge {
	text-align: center;
	color: var(--accent);
	font-size: 0.9em;
	padding: 6px;
}

.agreeBtn {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	width: 100%;
	padding: 10px;
	border-radius: 8px;
	border: 1px solid var(--accent);
	background: transparent;
	color: var(--accent);
	cursor: pointer;
	font-size: 0.95em;

	&:hover {
		background: var(--accentedBg);
	}

	&:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
}

.messagePhase {
	padding: 8px 0;
}

.messageBox {
	p {
		font-size: 0.9em;
		margin-bottom: 8px;
	}
}

.messageInput {
	width: 100%;
	padding: 8px 12px;
	border-radius: 8px;
	border: 1px solid var(--divider);
	background: var(--bg);
	color: var(--fg);
	font-size: 0.95em;
	margin-bottom: 8px;
}

.messageActions {
	display: flex;
	gap: 8px;
}

.confirmBtn {
	padding: 8px 16px;
	border-radius: 6px;
	cursor: pointer;
}

.cancelBtn {
	padding: 8px 16px;
	border-radius: 6px;
	border: 1px solid var(--divider);
	background: transparent;
	color: var(--fg);
	cursor: pointer;
}
</style>
