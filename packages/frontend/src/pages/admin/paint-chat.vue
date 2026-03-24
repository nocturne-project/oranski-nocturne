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
			<template #label>お題リスト</template>
			<div :class="$style.section">
				<MkTextarea v-model="topicList" :class="$style.topicArea">
					<template #label>お題（1行に1つ）</template>
					<template #caption>改行区切りでお題を入力してください。ユーザーが「お題」ボタンを押すとランダムに1つ表示されます。</template>
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
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';
import { definePage } from '@/page.js';

const botAccountUsername = ref('');
const topicList = ref('');
const noticeText = ref('');

onMounted(async () => {
	try {
		const settings = await misskeyApi('admin/paint-chat/settings' as any) as any;
		botAccountUsername.value = settings.botAccountUsername ?? '';
		topicList.value = settings.topicList ?? '';
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
</style>
