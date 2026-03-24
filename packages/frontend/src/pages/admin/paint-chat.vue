<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div :class="$style.container">
		<MkFolder>
			<template #label>Botアカウント設定</template>
			<div :class="$style.section">
				<MkInput v-model="botAccountUsername">
					<template #label>Botアカウントのユーザー名</template>
					<template #caption>ランダム絵チャットの作品投稿・参加者呼びかけに使用するbotアカウント</template>
				</MkInput>
			</div>
		</MkFolder>

		<MkFolder>
			<template #label>お題リスト（汎用 - 全季節共通）</template>
			<div :class="$style.section">
				<MkTextarea v-model="topicList" :class="$style.topicArea">
					<template #label>汎用お題（1行に1つ）</template>
					<template #caption>どの季節でも出るお題です。改行区切りで入力してください。</template>
				</MkTextarea>
			</div>
		</MkFolder>

		<MkFolder>
			<template #label>お題リスト（春: 3〜5月）</template>
			<div :class="$style.section">
				<MkTextarea v-model="topicListSpring" :class="$style.topicArea">
					<template #label>春のお題（1行に1つ）</template>
					<template #caption>3月〜5月に出るお題です。汎用お題と合わせてランダムに選ばれます。</template>
				</MkTextarea>
			</div>
		</MkFolder>

		<MkFolder>
			<template #label>お題リスト（夏: 6〜8月）</template>
			<div :class="$style.section">
				<MkTextarea v-model="topicListSummer" :class="$style.topicArea">
					<template #label>夏のお題（1行に1つ）</template>
					<template #caption>6月〜8月に出るお題です。</template>
				</MkTextarea>
			</div>
		</MkFolder>

		<MkFolder>
			<template #label>お題リスト（秋: 9〜11月）</template>
			<div :class="$style.section">
				<MkTextarea v-model="topicListAutumn" :class="$style.topicArea">
					<template #label>秋のお題（1行に1つ）</template>
					<template #caption>9月〜11月に出るお題です。</template>
				</MkTextarea>
			</div>
		</MkFolder>

		<MkFolder>
			<template #label>お題リスト（冬: 12〜2月）</template>
			<div :class="$style.section">
				<MkTextarea v-model="topicListWinter" :class="$style.topicArea">
					<template #label>冬のお題（1行に1つ）</template>
					<template #caption>12月〜2月に出るお題です。</template>
				</MkTextarea>
			</div>
		</MkFolder>

		<MkFolder>
			<template #label>注意事項テキスト</template>
			<div :class="$style.section">
				<MkTextarea v-model="noticeText" :class="$style.noticeArea">
					<template #label>注意事項</template>
					<template #caption>マッチング開始前にユーザーに表示される注意事項テキスト。空の場合はデフォルトの注意事項が表示されます。</template>
				</MkTextarea>
			</div>
		</MkFolder>

		<div :class="$style.actions">
			<button class="_buttonPrimary" :class="$style.saveButton" @click="save">
				保存
			</button>
		</div>

		<MkFolder>
			<template #label>ステガノグラフィ抽出ツール</template>
			<div :class="$style.section">
				<p :class="$style.stegoDesc">画像ファイルからルームIDを抽出します。ランダム絵チャットで生成された画像には、ルームIDがステガノグラフィで埋め込まれています。</p>
				<input type="file" accept="image/*" :class="$style.fileInput" @change="onStegoFileSelect">
				<div v-if="stegoResult !== null" :class="$style.stegoResult">
					<template v-if="stegoResult">
						ルームID: <code>{{ stegoResult }}</code>
					</template>
					<template v-else>
						ルームIDが見つかりませんでした。
					</template>
				</div>
			</div>
		</MkFolder>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import { extractRoomId } from '@/pages/paintchat/room.steganography.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';
import { definePage } from '@/page.js';

const botAccountUsername = ref('');
const topicList = ref('');
const topicListSpring = ref('');
const topicListSummer = ref('');
const topicListAutumn = ref('');
const topicListWinter = ref('');
const noticeText = ref('');
const stegoResult = ref<string | null>(null);

onMounted(async () => {
	try {
		const settings = await misskeyApi('admin/paint-chat/settings' as any) as any;
		botAccountUsername.value = settings.botAccountUsername ?? '';
		topicList.value = settings.topicList ?? '';
		topicListSpring.value = settings.topicListSpring ?? '';
		topicListSummer.value = settings.topicListSummer ?? '';
		topicListAutumn.value = settings.topicListAutumn ?? '';
		topicListWinter.value = settings.topicListWinter ?? '';
		noticeText.value = settings.noticeText ?? '';
	} catch {
		os.alert({ type: 'error', text: '設定の読み込みに失敗しました' });
	}
});

async function save() {
	try {
		await misskeyApi('admin/paint-chat/settings/update' as any, {
			botAccountUsername: botAccountUsername.value || null,
			topicList: topicList.value,
			topicListSpring: topicListSpring.value,
			topicListSummer: topicListSummer.value,
			topicListAutumn: topicListAutumn.value,
			topicListWinter: topicListWinter.value,
			noticeText: noticeText.value,
		} as any);
		os.alert({ type: 'success', text: '保存しました' });
	} catch (e: any) {
		if (e.code === 'NO_SUCH_USER') {
			os.alert({ type: 'error', text: '指定されたユーザーが見つかりません' });
		} else {
			os.alert({ type: 'error', text: '保存に失敗しました' });
		}
	}
}

// ステガノグラフィ抽出: 画像ファイルからルームIDを抽出する（FR-038）
function onStegoFileSelect(e: Event) {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) return;

	const reader = new FileReader();
	reader.onload = () => {
		const img = new Image();
		img.onload = () => {
			const tmpCanvas = window.document.createElement('canvas');
			tmpCanvas.width = img.width;
			tmpCanvas.height = img.height;
			const tmpCtx = tmpCanvas.getContext('2d')!;
			tmpCtx.drawImage(img, 0, 0);

			const roomId = extractRoomId(tmpCanvas);
			stegoResult.value = roomId ?? '';
		};
		img.src = reader.result as string;
	};
	reader.readAsDataURL(file);
}

definePage(() => ({
	title: 'ランダム絵チャット設定',
	icon: 'ti ti-brush',
}));
</script>

<style lang="scss" module>
.container {
	max-width: 800px;
	margin: 0 auto;
	padding: 16px;
}

.section {
	padding: 16px;
}

.topicArea {
	min-height: 200px;
}

.noticeArea {
	min-height: 150px;
}

.actions {
	padding: 16px;
	display: flex;
	justify-content: flex-end;
}

.saveButton {
	padding: 10px 24px;
	border-radius: 8px;
	cursor: pointer;
}

.stegoDesc {
	font-size: 0.9em;
	color: var(--fgTransparent);
	margin-bottom: 12px;
}

.fileInput {
	margin-bottom: 12px;
}

.stegoResult {
	padding: 8px 12px;
	background: var(--bgSecondary);
	border-radius: 6px;
	font-size: 0.95em;

	code {
		font-family: monospace;
		background: var(--bg);
		padding: 2px 6px;
		border-radius: 4px;
	}
}
</style>
