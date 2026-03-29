/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import type { DrawingRoomSettingsRepository, DrawingUserSettingsRepository, MiDrawingRoomSettings, MiDrawingUserSettings } from '@/models/_.js';

export interface RoomSettings {
	canvasWidth: number;
	canvasHeight: number;
}

export interface UserSettings {
	currentTool: 'pen' | 'eraser' | 'eyedropper' | 'move';
	currentColor: string;
	currentOpacity: number;
	strokeWidth: number;
	currentLayer: number;
	layerVisible: boolean[];
	layerOpacity: number[];
	zoomLevel: number;
	panOffsetX: number;
	panOffsetY: number;
	// colors は DB に存在しないため除外
	// グループチャット描画アップグレードで追加されたフィールド
	colorHistory: string[]; // ユーザーが使用した色の履歴
	pressureEnabled: boolean; // 筆圧感知の有効/無効
	penStrokeWidth: number; // ペンツールのストローク幅
	eraserStrokeWidth: number; // 消しゴムツールのストローク幅
}

@Injectable()
export class DrawingSettingsService {
	constructor(
		@Inject(DI.drawingRoomSettingsRepository)
		private drawingRoomSettingsRepository: DrawingRoomSettingsRepository,

		@Inject(DI.drawingUserSettingsRepository)
		private drawingUserSettingsRepository: DrawingUserSettingsRepository,

		private idService: IdService,
	) {}

	@bindThis
	public async getRoomSettings(canvasId: string): Promise<RoomSettings> {
		const settings = await this.drawingRoomSettingsRepository.findOneBy({ id: canvasId });

		if (settings) {
			return {
				canvasWidth: settings.canvasWidth,
				canvasHeight: settings.canvasHeight,
			};
		}

		// デフォルトキャンバスサイズ: 1600x1200（グループチャット描画アップグレード対応）
		return {
			canvasWidth: 1600,
			canvasHeight: 1200,
		};
	}

	@bindThis
	public async saveRoomSettings(canvasId: string, settings: Partial<RoomSettings>): Promise<MiDrawingRoomSettings> {
		const existing = await this.drawingRoomSettingsRepository.findOneBy({ id: canvasId });

		if (existing) {
			// 既存設定を更新
			if (settings.canvasWidth !== undefined) {
				existing.canvasWidth = settings.canvasWidth;
			}
			if (settings.canvasHeight !== undefined) {
				existing.canvasHeight = settings.canvasHeight;
			}
			existing.updatedAt = new Date();

			return await this.drawingRoomSettingsRepository.save(existing);
		} else {
			// 新規作成
			const newSettings = this.drawingRoomSettingsRepository.create({
				id: canvasId,
				canvasWidth: settings.canvasWidth ?? 1600,
				canvasHeight: settings.canvasHeight ?? 1200,
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			return await this.drawingRoomSettingsRepository.insert(newSettings).then(() => newSettings);
		}
	}

	@bindThis
	public async getUserSettings(userId: string, canvasId: string): Promise<UserSettings> {
		const settings = await this.drawingUserSettingsRepository.findOneBy({
			userId,
			canvasId,
		});

		if (settings) {
			return {
				currentTool: settings.currentTool as 'pen' | 'eraser' | 'eyedropper',
				currentColor: settings.currentColor,
				currentOpacity: settings.currentOpacity,
				strokeWidth: settings.strokeWidth,
				currentLayer: settings.currentLayer,
				layerVisible: settings.layerVisible,
				layerOpacity: settings.layerOpacity,
				zoomLevel: settings.zoomLevel,
				panOffsetX: settings.panOffsetX,
				panOffsetY: settings.panOffsetY,
				// 新規フィールド（後方互換: DBに値がない場合はデフォルト値を使用）
				colorHistory: (settings as any).colorHistory ?? [],
				pressureEnabled: (settings as any).pressureEnabled ?? true,
				penStrokeWidth: (settings as any).penStrokeWidth ?? 5,
				eraserStrokeWidth: (settings as any).eraserStrokeWidth ?? 20,
			};
		}

		// デフォルト値を返す
		return {
			currentTool: 'pen',
			currentColor: '#000000',
			currentOpacity: 1.0,
			strokeWidth: 2,
			currentLayer: 0,
			layerVisible: [true, true, true],
			layerOpacity: [1, 1, 1],
			zoomLevel: 1.0,
			panOffsetX: 0,
			panOffsetY: 0,
			// グループチャット描画アップグレードで追加されたデフォルト値
			colorHistory: [],
			pressureEnabled: true,
			penStrokeWidth: 5,
			eraserStrokeWidth: 20,
		};
	}

	@bindThis
	public async saveUserSettings(userId: string, canvasId: string, settings: Partial<UserSettings>): Promise<MiDrawingUserSettings> {
		const existing = await this.drawingUserSettingsRepository.findOneBy({
			userId,
			canvasId,
		});

		if (existing) {
			// 既存設定を更新
			if (settings.currentTool !== undefined) {
				existing.currentTool = settings.currentTool;
			}
			if (settings.currentColor !== undefined) {
				existing.currentColor = settings.currentColor;
			}
			if (settings.currentOpacity !== undefined) {
				existing.currentOpacity = settings.currentOpacity;
			}
			if (settings.strokeWidth !== undefined) {
				existing.strokeWidth = settings.strokeWidth;
			}
			if (settings.currentLayer !== undefined) {
				existing.currentLayer = settings.currentLayer;
			}
			if (settings.layerVisible !== undefined) {
				existing.layerVisible = settings.layerVisible;
			}
			if (settings.layerOpacity !== undefined) {
				existing.layerOpacity = settings.layerOpacity;
			}
			if (settings.zoomLevel !== undefined) {
				existing.zoomLevel = settings.zoomLevel;
			}
			if (settings.panOffsetX !== undefined) {
				existing.panOffsetX = settings.panOffsetX;
			}
			if (settings.panOffsetY !== undefined) {
				existing.panOffsetY = settings.panOffsetY;
			}
			// colors カラムはDBに存在しないためスキップ（エンティティ定義のみ）
			// if (settings.colors !== undefined) {
			// 	existing.colors = settings.colors;
			// }
			// グループチャット描画アップグレードで追加されたフィールドの保存
			if (settings.colorHistory !== undefined) {
				(existing as any).colorHistory = settings.colorHistory;
			}
			if (settings.pressureEnabled !== undefined) {
				(existing as any).pressureEnabled = settings.pressureEnabled;
			}
			if (settings.penStrokeWidth !== undefined) {
				(existing as any).penStrokeWidth = settings.penStrokeWidth;
			}
			if (settings.eraserStrokeWidth !== undefined) {
				(existing as any).eraserStrokeWidth = settings.eraserStrokeWidth;
			}
			existing.updatedAt = new Date();

			return await this.drawingUserSettingsRepository.save(existing);
		} else {
			// 新規作成
			const newSettings = this.drawingUserSettingsRepository.create({
				id: this.idService.gen(),
				userId,
				canvasId,
				currentTool: settings.currentTool ?? 'pen',
				currentColor: settings.currentColor ?? '#000000',
				currentOpacity: settings.currentOpacity ?? 1.0,
				strokeWidth: settings.strokeWidth ?? 2,
				currentLayer: settings.currentLayer ?? 0,
				layerVisible: settings.layerVisible ?? [true, true, true],
				layerOpacity: settings.layerOpacity ?? [1, 1, 1],
				zoomLevel: settings.zoomLevel ?? 1.0,
				panOffsetX: settings.panOffsetX ?? 0,
				panOffsetY: settings.panOffsetY ?? 0,
				// colors カラムはDBに存在しないためスキップ
				// グループチャット描画アップグレードで追加されたフィールド
				colorHistory: settings.colorHistory ?? [],
				pressureEnabled: settings.pressureEnabled ?? true,
				penStrokeWidth: settings.penStrokeWidth ?? 5,
				eraserStrokeWidth: settings.eraserStrokeWidth ?? 20,
				createdAt: new Date(),
				updatedAt: new Date(),
			} as any);

			await this.drawingUserSettingsRepository.insert(newSettings);
			return newSettings as unknown as MiDrawingUserSettings;
		}
	}
}
