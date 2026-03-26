/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Column } from 'typeorm';
import { id } from './util/id.js';

// ランダム絵チャットのルーム。マッチング成立時に作成される。
@Entity('paint_chat_room')
export class PaintChatRoom {
	@PrimaryColumn(id())
	public id: string;

	// ルーム状態: active（進行中）, ended（終了）
	@Column('varchar', {
		length: 16,
		default: 'active',
	})
	public status: 'active' | 'ended';

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public createdAt: Date;

	// ルーム終了日時
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public endedAt: Date | null;

	// 通報されたルームか
	@Column('boolean', {
		default: false,
	})
	public isReported: boolean;

	// bot投稿済みか
	@Column('boolean', {
		default: false,
	})
	public isPublished: boolean;

	// RedisからDBに退避されたキャンバスストロークデータ（JSON配列）
	@Column('jsonb', {
		nullable: true,
		default: null,
	})
	public canvasStrokes: unknown[] | null;

	// RedisからDBに退避されたマージ済み画像（Base64文字列）
	@Column('text', {
		nullable: true,
		default: null,
	})
	public canvasMergedImage: string | null;
}
