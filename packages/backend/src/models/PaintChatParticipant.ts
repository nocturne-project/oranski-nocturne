/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { PaintChatRoom } from './PaintChatRoom.js';

// ルームの参加者。ラッパーユーザーIDがフロントエンドに露出する唯一のID。
@Entity('paint_chat_participant')
export class PaintChatParticipant {
	// ラッパーユーザーID（フロントエンドに露出する）
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column({
		...id(),
	})
	public roomId: PaintChatRoom['id'];

	@ManyToOne(() => PaintChatRoom, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public room: PaintChatRoom | null;

	// 実ユーザーID（サーバー側のみ参照可能）
	@Index()
	@Column({
		...id(),
	})
	public userId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public user: MiUser | null;

	// 匿名名（例: 「あおいペンギン」）
	@Column('varchar', {
		length: 64,
	})
	public anonymousName: string;

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public joinedAt: Date;

	// 退出日時
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public leftAt: Date | null;

	// 色設定（選択中の色・最近使った色）。リロード時に復元する。
	@Column('jsonb', {
		nullable: true,
		default: null,
	})
	public colorPreferences: { currentColor: string; colorHistory: string[]; penWidth?: number; eraserWidth?: number; pressureEnabled?: boolean } | null;
}
