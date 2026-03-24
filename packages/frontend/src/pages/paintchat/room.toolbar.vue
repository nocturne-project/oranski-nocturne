<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- マジカルドロー風の左サイドバーツールバー。常に表示、スクロール不要。 -->
<div :class="$style.sidebar">
	<!-- 移動ツール（マジカルドロー風、一番上に配置） -->
	<button
		:class="[$style.btn, currentTool === 'move' ? $style.active : '']"
		@click="selectTool('move')"
	><i class="ti ti-arrows-move"></i></button>

	<!-- ツール選択 -->
	<button
		:class="[$style.btn, currentTool === 'pen' ? $style.active : '']"
		@click="selectTool('pen')"
	><i class="ti ti-pencil"></i></button>
	<button
		:class="[$style.btn, currentTool === 'eraser' ? $style.active : '']"
		@click="selectTool('eraser')"
	><i class="ti ti-eraser"></i></button>
	<button
		:class="[$style.btn, currentTool === 'eyedropper' ? $style.active : '']"
		@click="selectTool('eyedropper')"
	><i class="ti ti-color-picker"></i></button>

	<!-- 色（現在色のドット表示） -->
	<button :class="$style.btn" @click="togglePanel('color')">
		<span :class="$style.colorDot" :style="{ background: currentColor }"></span>
	</button>

	<!-- 太さ -->
	<button :class="$style.btn" @click="togglePanel('width')">
		<i class="ti ti-line-height"></i>
	</button>

	<div :class="$style.separator"></div>

	<!-- アンドゥ -->
	<button :class="$style.btn" @click="$emit('undo')">
		<i class="ti ti-arrow-back-up"></i>
	</button>

	<!-- ズーム -->
	<button :class="[$style.btn, $style.textBtn]" @click="$emit('zoomOut')">縮小</button>
	<button :class="[$style.btn, $style.textBtn]" @click="$emit('zoomIn')">拡大</button>

	<div :class="$style.separator"></div>

	<!-- 保存 -->
	<button :class="$style.btn" @click="togglePanel('download')">
		<i class="ti ti-download"></i>
	</button>

	<div :class="$style.separator"></div>

	<!-- チャット（未読時に光る） -->
	<button :class="[$style.btn, hasUnreadChat ? $style.unreadGlow : '']" @click="$emit('toggleChat')">
		<i class="ti ti-message-circle"></i>
	</button>

	<!-- 投稿 -->
	<button :class="$style.btn" @click="$emit('publish')">
		<i class="ti ti-share"></i>
	</button>

	<div :class="$style.bottomSpacer"></div>

	<!-- 通報 -->
	<button :class="[$style.btn, $style.dangerBtn]" @click="$emit('report')">
		<i class="ti ti-flag"></i>
	</button>

	<!-- 退出 -->
	<button :class="[$style.btn, $style.dangerBtn]" @click="$emit('leave')">
		<i class="ti ti-door-exit"></i>
	</button>
</div>

<!-- 展開パネル（サイドバーの右隣に表示） -->
<div v-if="activePanel" :class="$style.panel">
	<div :class="$style.panelHeader">
		<span v-if="activePanel === 'color'">色選択</span>
		<span v-else-if="activePanel === 'width'">太さ / 透明度</span>
		<span v-else-if="activePanel === 'download'">保存</span>
		<button :class="$style.panelClose" @click="activePanel = null">閉じる</button>
	</div>

	<!-- カラー選択 -->
	<template v-if="activePanel === 'color'">
		<!-- カラーピッカー（input type=color） -->
		<div :class="$style.colorPickerRow">
			<input
				type="color"
				:value="currentColor"
				:class="$style.colorPickerInput"
				@input="onColorPickerChange"
			>
			<span :class="$style.colorHex">{{ currentColor }}</span>
		</div>

		<!-- プリセットパレット -->
		<div :class="$style.sectionLabel">プリセット</div>
		<div :class="$style.colorGrid">
			<button
				v-for="color in colors"
				:key="color"
				:class="[$style.colorCell, currentColor === color ? $style.colorSelected : '']"
				:style="{ background: color }"
				@click="selectColor(color)"
			></button>
		</div>

		<!-- カラーヒストリー（最近使った色） -->
		<div v-if="colorHistory.length > 0" :class="$style.colorHistorySection">
			<div :class="$style.sectionLabel">最近使った色</div>
			<div :class="$style.colorGrid">
				<button
					v-for="(color, idx) in colorHistory"
					:key="'h-' + idx"
					:class="[$style.colorCell, currentColor === color ? $style.colorSelected : '']"
					:style="{ background: color }"
					@click="selectColor(color)"
				></button>
			</div>
		</div>
	</template>

	<!-- 太さ + 透明度 -->
	<template v-if="activePanel === 'width'">
		<div :class="$style.widthSection">
			<span :class="$style.sectionLabel">太さ</span>
			<div :class="$style.widthGrid">
				<button
					v-for="w in widths"
					:key="w"
					:class="[$style.widthCell, currentWidth === w ? $style.widthSelected : '']"
					@click="selectWidth(w)"
				>
					<span :class="$style.widthCircle" :style="{ width: Math.min(w * 2, 20) + 'px', height: Math.min(w * 2, 20) + 'px' }"></span>
					<span :class="$style.widthLabel">{{ w }}</span>
				</button>
			</div>
		</div>
		<div :class="$style.opacitySection">
			<span :class="$style.sectionLabel">透明度: {{ Math.round(currentOpacity * 100) }}%</span>
			<input
				type="range"
				min="10"
				max="100"
				:value="currentOpacity * 100"
				:class="$style.opacitySlider"
				@input="onOpacityChange"
			>
		</div>
	</template>

	<!-- ダウンロード -->
	<template v-if="activePanel === 'download'">
		<button :class="$style.panelAction" @click="$emit('downloadAll')">
			キャンバス全体を保存
		</button>
		<button :class="$style.panelAction" @click="$emit('downloadMine')">
			自分の絵のみ保存
		</button>
	</template>
</div>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue';
import type { ToolType } from './room.types.js';

const emit = defineEmits<{
	(e: 'toolChange', tool: ToolType): void;
	(e: 'colorChange', color: string): void;
	(e: 'widthChange', width: number): void;
	(e: 'opacityChange', opacity: number): void;
	(e: 'undo'): void;
	(e: 'zoomIn'): void;
	(e: 'zoomOut'): void;
	(e: 'zoomReset'): void;
	(e: 'moveMode', enabled: boolean): void;
	(e: 'downloadAll'): void;
	(e: 'downloadMine'): void;
	(e: 'toggleChat'): void;
	(e: 'publish'): void;
	(e: 'report'): void;
	(e: 'leave'): void;
}>();

const props = defineProps<{
	hasUnreadChat?: boolean;
}>();

const hasUnreadChat = computed(() => props.hasUnreadChat ?? false);

const currentTool = ref<ToolType>('pen');

// ペンと消しゴムの太さを個別に記憶
const penWidth = ref(3);
const eraserWidth = ref(20);
const currentColor = ref('#000000');
const currentWidth = ref(3);
const currentOpacity = ref(1.0);
const activePanel = ref<'color' | 'width' | 'download' | null>(null);

// カラーヒストリー（最近使った色、最大10件、重複なし）
const colorHistory = ref<string[]>([]);

const colors = [
	'#000000', '#ffffff', '#ff0000', '#ff6600', '#ffcc00',
	'#33cc33', '#0099ff', '#6633ff', '#ff33cc', '#996633',
	'#666666', '#cccccc', '#ff6666', '#ffcc99', '#ffff66',
	'#99ff99', '#66ccff', '#cc99ff', '#ffccee', '#cc9966',
];

const widths = [1, 2, 3, 5, 8, 12, 20, 40, 80, 120, 200];

function selectTool(tool: ToolType) {
	// 現在のツールの太さを保存
	if (currentTool.value === 'pen') penWidth.value = currentWidth.value;
	else if (currentTool.value === 'eraser') eraserWidth.value = currentWidth.value;

	currentTool.value = tool;

	// 新しいツールの太さを復元
	if (tool === 'pen') {
		currentWidth.value = penWidth.value;
		emit('widthChange', penWidth.value);
	} else if (tool === 'eraser') {
		currentWidth.value = eraserWidth.value;
		emit('widthChange', eraserWidth.value);
	}

	emit('toolChange', tool);
	emit('moveMode', tool === 'move');
}

// パネルを閉じて色を選択する（プリセット/ヒストリーのタップ用）
function selectColor(color: string) {
	applyColor(color);
	activePanel.value = null;
}

// パネルを閉じずに色を適用する（カラーピッカー/スライダー用: FR-062）
function applyColor(color: string) {
	const idx = colorHistory.value.indexOf(color);
	if (idx >= 0) colorHistory.value.splice(idx, 1);
	colorHistory.value.unshift(color);
	if (colorHistory.value.length > 10) colorHistory.value.pop();

	currentColor.value = color;
	emit('colorChange', color);
}

// カラーピッカー（input type=color）の変更ハンドラ: パネルは閉じない
function onColorPickerChange(e: Event) {
	const color = (e.target as HTMLInputElement).value;
	applyColor(color);
}

// 外部からスポイトで色を設定する（room.vueから呼ばれる）
function setColorFromEyedropper(color: string) {
	applyColor(color);
	selectTool('pen');
}

function selectWidth(width: number) {
	currentWidth.value = width;
	emit('widthChange', width);
}

function onOpacityChange(e: Event) {
	const value = parseInt((e.target as HTMLInputElement).value, 10) / 100;
	currentOpacity.value = value;
	emit('opacityChange', value);
}

function togglePanel(panel: 'color' | 'width' | 'download') {
	activePanel.value = activePanel.value === panel ? null : panel;
}

defineExpose({ setColorFromEyedropper });
</script>

<style lang="scss" module>
// 左サイドバー（マジカルドロー風）。常に表示、縦配置。
.sidebar {
	position: absolute;
	left: 0;
	top: 0;
	bottom: 0;
	width: 44px;
	background: var(--panel, #2a2a3e);
	border-right: 1px solid var(--divider);
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 4px 0;
	gap: 2px;
	z-index: 10;
	overflow-y: auto;
	overflow-x: hidden;

	// スクロールバーを非表示
	&::-webkit-scrollbar { width: 0; }
	scrollbar-width: none;
}

.btn {
	width: 36px;
	height: 36px;
	border-radius: 8px;
	border: none;
	background: transparent;
	color: var(--fg);
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 18px;
	flex-shrink: 0;

	&:hover {
		background: var(--bg, rgba(255,255,255,0.1));
	}
}

// アクティブツールの強調表示（高コントラスト + 左インジケーター + グロー効果）
.active {
	background: #5b86e5 !important;
	color: #ffffff !important;
	box-shadow: 0 0 8px rgba(91, 134, 229, 0.6), inset 0 0 0 1px rgba(255, 255, 255, 0.3);
	position: relative;

	&::before {
		content: '';
		position: absolute;
		left: 0;
		top: 4px;
		bottom: 4px;
		width: 3px;
		background: #ffffff;
		border-radius: 0 2px 2px 0;
	}
}

// テキスト付きボタン（サイドバー幅に収まるようフォントサイズ調整）
.textBtn {
	font-size: 10px;
	letter-spacing: -0.5px;
}

.colorDot {
	width: 20px;
	height: 20px;
	border-radius: 50%;
	border: 2px solid var(--fg);
}

.widthDot {
	border-radius: 50%;
	background: var(--fg);
	min-width: 4px;
	min-height: 4px;
}

.separator {
	width: 28px;
	height: 1px;
	background: var(--divider);
	margin: 4px 0;
	flex-shrink: 0;
}

// サイドバー下部に通報・退出を押し下げるスペーサー
.bottomSpacer {
	flex: 1;
}

// 未読チャット時のグロー効果
.unreadGlow {
	animation: chatPulse 1.5s ease-in-out infinite;
	color: #5b86e5 !important;
}

@keyframes chatPulse {
	0%, 100% { box-shadow: 0 0 4px rgba(91, 134, 229, 0.4); }
	50% { box-shadow: 0 0 12px rgba(91, 134, 229, 0.8); }
}

// 通報・退出など危険系ボタン
.dangerBtn {
	color: #ff6b6b !important;
	opacity: 0.7;

	&:hover {
		opacity: 1;
		background: rgba(255, 107, 107, 0.15) !important;
	}
}

// 展開パネル（サイドバーの右隣に表示）
.panel {
	position: absolute;
	left: 44px;
	top: 0;
	width: 200px;
	max-height: 100%;
	background: var(--panel, #2a2a3e);
	border-right: 1px solid var(--divider);
	z-index: 11;
	overflow-y: auto;
	padding: 8px;
}

.panelHeader {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 8px;
	font-size: 13px;
	font-weight: bold;
}

.panelClose {
	padding: 2px 8px;
	border-radius: 4px;
	border: 1px solid var(--divider);
	background: transparent;
	color: var(--fg);
	cursor: pointer;
	font-size: 12px;
}

// カラーピッカー行
.colorPickerRow {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
}

.colorPickerInput {
	width: 40px;
	height: 40px;
	border: none;
	border-radius: 8px;
	cursor: pointer;
	padding: 0;

	&::-webkit-color-swatch-wrapper { padding: 2px; }
	&::-webkit-color-swatch { border-radius: 6px; border: none; }
}

.colorHex {
	font-family: monospace;
	font-size: 12px;
	color: var(--fg);
}

.colorHistorySection {
	margin-top: 8px;
}

// カラーグリッド
.colorGrid {
	display: grid;
	grid-template-columns: repeat(5, 1fr);
	gap: 4px;
}

.colorCell {
	width: 32px;
	height: 32px;
	border-radius: 6px;
	border: 2px solid transparent;
	cursor: pointer;

	&:hover { border-color: var(--fg); }
}

.colorSelected {
	border-color: var(--accent) !important;
	box-shadow: 0 0 0 2px var(--accent);
}

// 太さセクション
.widthSection, .opacitySection {
	margin-bottom: 12px;
}

.sectionLabel {
	font-size: 12px;
	color: var(--fgTransparent);
	display: block;
	margin-bottom: 6px;
}

.widthGrid {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

.widthCell {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	padding: 4px 8px;
	border-radius: 6px;
	border: 1px solid var(--divider);
	background: transparent;
	cursor: pointer;
	color: var(--fg);

	&:hover { background: var(--bg); }
}

.widthSelected {
	border-color: var(--accent);
	background: var(--accentedBg, rgba(134,179,0,0.1));
}

// 太さプレビューの丸（黒色固定、白背景で高コントラスト）
.widthCircle {
	border-radius: 50%;
	background: #000000;
	min-width: 4px;
	min-height: 4px;
}

.widthLabel {
	font-size: 10px;
	color: var(--fg);
}

// 太さセルの白背景（暗いテーマでもプレビューが見える）
.widthCell {
	background: #ffffff !important;
	color: #333333 !important;

	&:hover { background: #f0f0f0 !important; }
}

.widthSelected {
	border-color: #5b86e5 !important;
	background: #e8f0ff !important;
	box-shadow: 0 0 0 2px #5b86e5;
}

.opacitySlider {
	width: 100%;
}

// ダウンロードアクション
.panelAction {
	display: block;
	width: 100%;
	padding: 10px;
	margin-bottom: 4px;
	border-radius: 6px;
	border: none;
	background: transparent;
	color: var(--fg);
	cursor: pointer;
	font-size: 13px;
	text-align: left;

	&:hover { background: var(--bg); }
}
</style>
