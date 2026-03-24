<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkStickyContainer>
	<template #header>
		<MkPageHeader :actions="[]" :tabs="[]"/>
	</template>

	<div :class="$style.container">
		<!-- 注意事項画面 -->
		<div v-if="phase === 'notice'" :class="$style.noticePhase">
			<div :class="$style.noticeBox">
				<h2 :class="$style.noticeTitle">ランダム絵チャット - 注意事項</h2>
				<div :class="$style.noticeContent">
					<template v-if="noticeText">
						<div v-text="noticeText"></div>
					</template>
					<template v-else>
						<ul :class="$style.noticeList">
							<li>相手が描いた絵の無断転載は禁止です</li>
							<li>相手の絵のAI学習・AI利用への転用は禁止です</li>
							<li>合作として自分のアカウントに投稿したい場合は、チャットで相手の許可を得てください</li>
							<li>自分が描いた部分のみであれば、カミングアウトにはなりますが投稿は問題ありません</li>
							<li>不適切な描画やメッセージは通報の対象となります</li>
							<li>ルームデータは7日間保持後に自動削除されます</li>
						</ul>
					</template>
				</div>
				<button :class="$style.agreeButton" class="_buttonPrimary" @click="startMatching">
					同意してマッチング開始
				</button>
			</div>
		</div>

		<!-- マッチング待機画面 -->
		<div v-else-if="phase === 'waiting'" :class="$style.waitingPhase">
			<div :class="$style.waitingBox">
				<div :class="$style.waitingAnimation">
					<i class="ti ti-brush" :class="$style.waitingIcon"></i>
				</div>
				<p :class="$style.waitingText">マッチング待機中...</p>
				<p :class="$style.waitingSubText">相手が見つかるまでお待ちください</p>
				<button :class="$style.cancelButton" class="_buttonGradate" @click="cancelMatching">
					キャンセル
				</button>
			</div>
		</div>
	</div>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { ref, onUnmounted } from 'vue';
import MkStickyContainer from '@/components/global/MkStickyContainer.vue';
import MkPageHeader from '@/components/global/MkPageHeader.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useRouter } from '@/router.js';
import { useStream } from '@/stream.js';
import { definePage } from '@/page.js';
import * as os from '@/os.js';

// ページの状態: notice(注意事項表示) → waiting(マッチング待機中)
const phase = ref<'notice' | 'waiting'>('notice');
const noticeText = ref('');
const router = useRouter();
const stream = useStream();
// ポーリングは不要。WebSocketのmainストリームでmatchedイベントを待つ。

// 注意事項テキストを取得
misskeyApi('paint-chat/settings' as any).then((res: any) => {
	if (res.noticeText) {
		noticeText.value = res.noticeText;
	}
}).catch(() => {
	// 設定未取得でもデフォルトの注意事項を表示
});

// mainストリームでマッチング成立を監視
const mainConnection = stream.useChannel('main');
mainConnection.on('paintChatMatched' as any, (data: any) => {
	// マッチング成立: ルーム画面に遷移
	(router as any).push(`/paintchat/${data.roomId}`);
});

// マッチング開始（joinを1回だけ呼び、以降はWebSocketのpaintChatMatchedイベントで通知を待つ）
async function startMatching() {
	phase.value = 'waiting';

	try {
		const res = await misskeyApi('paint-chat/join' as any) as any;
		if (res.status === 'matched' && res.roomId) {
			// 即マッチング成立
			(router as any).push(`/paintchat/${res.roomId}`);
			return;
		}
		// status === 'waiting' の場合はWebSocketでmatchedイベントを待つ
	} catch (e: any) {
		if (e.code === 'ALREADY_WAITING') {
			// 既に待機中の場合はWebSocketイベントを待つ
		} else {
			phase.value = 'notice';
			await os.alert({ type: 'error', text: 'マッチングの開始に失敗しました' });
			return;
		}
	}
}

// マッチングキャンセル
async function cancelMatching() {
	try {
		await misskeyApi('paint-chat/leave-queue' as any);
	} catch {
		// キャンセル失敗時もUIは戻す（10分TTLで自動期限切れ）
	}
	phase.value = 'notice';
}

onUnmounted(() => {
	mainConnection.dispose();
});

definePage(() => ({
	title: 'ランダム絵チャット',
	icon: 'ti ti-brush',
}));
</script>

<style lang="scss" module>
.container {
	max-width: 600px;
	margin: 0 auto;
	padding: 20px;
}

.noticePhase {
	display: flex;
	justify-content: center;
}

.noticeBox {
	background: var(--bg);
	border-radius: 12px;
	padding: 24px;
	width: 100%;
}

.noticeTitle {
	font-size: 1.2em;
	margin-bottom: 16px;
	text-align: center;
}

.noticeContent {
	margin-bottom: 24px;
	line-height: 1.8;
}

.noticeList {
	padding-left: 20px;

	li {
		margin-bottom: 8px;
	}
}

.agreeButton {
	display: block;
	width: 100%;
	padding: 12px;
	border-radius: 8px;
	font-size: 1em;
	cursor: pointer;
}

.waitingPhase {
	display: flex;
	justify-content: center;
	align-items: center;
	min-height: 400px;
}

.waitingBox {
	text-align: center;
}

.waitingAnimation {
	margin-bottom: 24px;
}

.waitingIcon {
	font-size: 64px;
	color: var(--accent);
	animation: pulse 2s ease-in-out infinite;
}

.waitingText {
	font-size: 1.2em;
	margin-bottom: 8px;
}

.waitingSubText {
	color: var(--fgTransparent);
	margin-bottom: 24px;
}

.cancelButton {
	padding: 8px 24px;
	border-radius: 8px;
	cursor: pointer;
}

@keyframes pulse {
	0%, 100% { opacity: 1; transform: scale(1); }
	50% { opacity: 0.6; transform: scale(1.1); }
}
</style>
