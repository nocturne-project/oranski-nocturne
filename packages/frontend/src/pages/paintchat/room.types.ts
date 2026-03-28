/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// ツールの種類
export type ToolType = 'move' | 'pen' | 'eraser' | 'eyedropper';

// 筆圧ポイント
export interface PressurePoint {
	x: number;
	y: number;
	pressure: number;
}

// レイヤー設定
export const MAX_LAYERS = 3;

// ストロークデータ
export interface StrokeData {
	id: string;
	participantId: string;
	points: PressurePoint[];
	color: string;
	width: number;
	opacity: number;
	tool: ToolType;
	layer: number; // レイヤー番号（0, 1, 2）。0が最上層、2が最下層
	isHardwarePressure?: boolean; // ハードウェア筆圧（Apple Pencil等）で描画されたか（ローカルのみ）
}

// チャットメッセージの種別
export type MessageType = 'text' | 'topic' | 'dice' | 'system';

// チャットメッセージ
export interface ChatMessage {
	id: string;
	participantId: string | null;
	type: MessageType;
	content: string;
	createdAt: string;
}

// 参加者情報（フロントエンドに露出するのはラッパーユーザーIDと匿名名のみ）
export interface Participant {
	id: string; // ラッパーユーザーID
	anonymousName: string;
}

// ルーム情報
export interface RoomInfo {
	id: string;
	status: 'active' | 'ended';
	createdAt: string;
	participants: Participant[];
	myParticipantId: string;
}

// プレゼンス状態
export type PresenceStatus = 'online' | 'offline';

// WebSocketイベント: マッチング成立
export interface MatchedEvent {
	roomId: string;
	myParticipantId: string;
	myAnonymousName: string;
	partnerParticipantId: string;
	partnerAnonymousName: string;
}

// 投稿同意の状態
export interface PublishStatus {
	exists: boolean;
	bothAgreed: boolean;
	published: boolean;
	participant1Agreed: boolean;
	participant2Agreed: boolean;
}
