<template>
<!-- アイビスペイント風ツールバー: 画面下部にコンパクト配置、タップで展開するパネル式 -->
<div :class="$style.toolbar">
	<!-- メインツールバー（常時表示） -->
	<div :class="$style.mainBar">
		<!-- ツール選択 -->
		<button
			:class="[$style.toolBtn, currentTool === 'pen' ? $style.active : '']"
			@click="selectTool('pen')"
		>
			<i class="ti ti-pencil"></i>
		</button>
		<button
			:class="[$style.toolBtn, currentTool === 'eraser' ? $style.active : '']"
			@click="selectTool('eraser')"
		>
			<i class="ti ti-eraser"></i>
		</button>

		<!-- カラーボタン -->
		<button
			:class="$style.colorBtn"
			:style="{ background: currentColor }"
			@click="togglePanel('color')"
		></button>

		<!-- 太さボタン -->
		<button :class="$style.toolBtn" @click="togglePanel('width')">
			<div :class="$style.widthPreview" :style="{ width: currentWidth + 'px', height: currentWidth + 'px' }"></div>
		</button>

		<!-- アンドゥ・リドゥ -->
		<button :class="$style.toolBtn" @click="$emit('undo')">
			<i class="ti ti-arrow-back-up"></i>
		</button>

		<!-- ダウンロード -->
		<button :class="$style.toolBtn" @click="togglePanel('download')">
			<i class="ti ti-download"></i>
		</button>
	</div>

	<!-- 展開パネル -->
	<div v-if="activePanel === 'color'" :class="$style.panel">
		<div :class="$style.colorPalette">
			<button
				v-for="color in colors"
				:key="color"
				:class="[$style.paletteColor, currentColor === color ? $style.selectedColor : '']"
				:style="{ background: color }"
				@click="selectColor(color)"
			></button>
		</div>
		<!-- 透明度スライダー -->
		<div :class="$style.sliderRow">
			<span :class="$style.sliderLabel">透明度</span>
			<input
				type="range"
				min="10"
				max="100"
				:value="currentOpacity * 100"
				:class="$style.slider"
				@input="onOpacityChange"
			>
			<span :class="$style.sliderValue">{{ Math.round(currentOpacity * 100) }}%</span>
		</div>
	</div>

	<div v-if="activePanel === 'width'" :class="$style.panel">
		<div :class="$style.widthOptions">
			<button
				v-for="w in widths"
				:key="w"
				:class="[$style.widthOption, currentWidth === w ? $style.selectedWidth : '']"
				@click="selectWidth(w)"
			>
				<div :class="$style.widthDot" :style="{ width: w + 'px', height: w + 'px' }"></div>
			</button>
		</div>
	</div>

	<div v-if="activePanel === 'download'" :class="$style.panel">
		<button :class="$style.panelBtn" @click="$emit('downloadAll')">
			<i class="ti ti-photo-down"></i> キャンバス全体をダウンロード
		</button>
		<button :class="$style.panelBtn" @click="$emit('downloadMine')">
			<i class="ti ti-user-down"></i> 自分の絵のみダウンロード
		</button>
	</div>
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
	(e: 'downloadAll'): void;
	(e: 'downloadMine'): void;
}>();

const currentTool = ref<ToolType>('pen');
const currentColor = ref('#000000');
const currentWidth = ref(3);
const currentOpacity = ref(1.0);
const activePanel = ref<'color' | 'width' | 'download' | null>(null);

// カラーパレット
const colors = [
	'#000000', '#ffffff', '#ff0000', '#ff6600', '#ffcc00',
	'#33cc33', '#0099ff', '#6633ff', '#ff33cc', '#996633',
	'#666666', '#cccccc', '#ff6666', '#ffcc99', '#ffff66',
	'#99ff99', '#66ccff', '#cc99ff', '#ffccee', '#cc9966',
];

// 線の太さ選択肢
const widths = [1, 2, 3, 5, 8, 12, 20];

function selectTool(tool: ToolType) {
	currentTool.value = tool;
	emit('toolChange', tool);
	activePanel.value = null;
}

function selectColor(color: string) {
	currentColor.value = color;
	emit('colorChange', color);
	activePanel.value = null;
}

function selectWidth(width: number) {
	currentWidth.value = width;
	emit('widthChange', width);
	activePanel.value = null;
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
.toolbar {
	position: relative;
	border-top: 1px solid var(--divider);
	background: var(--bg);
	flex-shrink: 0;
}

.mainBar {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	padding: 8px 12px;
}

.toolBtn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 44px;
	height: 44px;
	border-radius: 8px;
	border: none;
	background: transparent;
	cursor: pointer;
	font-size: 20px;
	color: var(--fg);
	transition: background 0.1s;

	&:hover {
		background: var(--bgSecondary);
	}
}

.active {
	background: var(--accent);
	color: white;

	&:hover {
		background: var(--accent);
	}
}

.colorBtn {
	width: 32px;
	height: 32px;
	border-radius: 50%;
	border: 2px solid var(--divider);
	cursor: pointer;
	flex-shrink: 0;
}

.widthPreview {
	border-radius: 50%;
	background: var(--fg);
	min-width: 4px;
	min-height: 4px;
}

.panel {
	position: absolute;
	bottom: 100%;
	left: 0;
	right: 0;
	background: var(--bg);
	border-top: 1px solid var(--divider);
	padding: 12px;
	box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
}

.colorPalette {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	justify-content: center;
}

.paletteColor {
	width: 32px;
	height: 32px;
	border-radius: 6px;
	border: 2px solid transparent;
	cursor: pointer;

	&:hover {
		border-color: var(--accent);
	}
}

.selectedColor {
	border-color: var(--accent);
	box-shadow: 0 0 0 2px var(--accent);
}

.sliderRow {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 12px;
}

.sliderLabel {
	font-size: 0.85em;
	white-space: nowrap;
}

.slider {
	flex: 1;
}

.sliderValue {
	font-size: 0.85em;
	min-width: 40px;
	text-align: right;
}

.widthOptions {
	display: flex;
	gap: 8px;
	justify-content: center;
	align-items: center;
}

.widthOption {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 44px;
	height: 44px;
	border-radius: 8px;
	border: 2px solid transparent;
	background: transparent;
	cursor: pointer;

	&:hover {
		background: var(--bgSecondary);
	}
}

.selectedWidth {
	border-color: var(--accent);
}

.widthDot {
	border-radius: 50%;
	background: var(--fg);
	min-width: 2px;
	min-height: 2px;
}

.panelBtn {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 10px 12px;
	border: none;
	background: transparent;
	cursor: pointer;
	font-size: 0.95em;
	color: var(--fg);
	border-radius: 6px;

	&:hover {
		background: var(--bgSecondary);
	}

	& + & {
		margin-top: 4px;
	}
}
</style>
