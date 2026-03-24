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

	<!-- 色（現在色のドット表示） -->
	<button :class="$style.btn" @click="togglePanel('color')">
		<span :class="$style.colorDot" :style="{ background: currentColor }"></span>
	</button>

	<!-- 太さ（プレビュー丸） -->
	<button :class="$style.btn" @click="togglePanel('width')">
		<span :class="$style.widthDot" :style="{ width: Math.min(currentWidth * 2, 16) + 'px', height: Math.min(currentWidth * 2, 16) + 'px' }"></span>
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
</div>

<!-- 展開パネル（サイドバーの右隣に表示） -->
<div v-if="activePanel" :class="$style.panel">
	<div :class="$style.panelHeader">
		<span v-if="activePanel === 'color'">色選択</span>
		<span v-else-if="activePanel === 'width'">太さ / 透明度</span>
		<span v-else-if="activePanel === 'download'">保存</span>
		<button :class="$style.panelClose" @click="activePanel = null">閉じる</button>
	</div>

	<!-- カラーパレット -->
	<template v-if="activePanel === 'color'">
		<div :class="$style.colorGrid">
			<button
				v-for="color in colors"
				:key="color"
				:class="[$style.colorCell, currentColor === color ? $style.colorSelected : '']"
				:style="{ background: color }"
				@click="selectColor(color)"
			></button>
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
import { ref } from 'vue';
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
}>();

const currentTool = ref<ToolType>('pen');
const currentColor = ref('#000000');
const currentWidth = ref(3);
const currentOpacity = ref(1.0);
const activePanel = ref<'color' | 'width' | 'download' | null>(null);

const colors = [
	'#000000', '#ffffff', '#ff0000', '#ff6600', '#ffcc00',
	'#33cc33', '#0099ff', '#6633ff', '#ff33cc', '#996633',
	'#666666', '#cccccc', '#ff6666', '#ffcc99', '#ffff66',
	'#99ff99', '#66ccff', '#cc99ff', '#ffccee', '#cc9966',
];

const widths = [1, 2, 3, 5, 8, 12, 20];

function selectTool(tool: ToolType) {
	currentTool.value = tool;
	emit('toolChange', tool);
	// 移動ツール選択時にmoveModeをemit
	emit('moveMode', tool === 'move');
}

function selectColor(color: string) {
	currentColor.value = color;
	emit('colorChange', color);
	activePanel.value = null;
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

// 太さプレビューの丸（暗い背景でも見えるように色を付ける）
.widthCircle {
	border-radius: 50%;
	background: var(--fg);
	min-width: 4px;
	min-height: 4px;
}

.widthLabel {
	font-size: 10px;
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
