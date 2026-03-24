/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { PaintChatRoom } from './PaintChatRoom.js';
import { PaintChatParticipant } from './PaintChatParticipant.js';

// 作品公開投稿の同意管理
@Entity('paint_chat_publish')
export class PaintChatPublish {
	@PrimaryColumn(id())
	public id: string;

	// 対象ルーム（1ルーム1レコード）
	@Column({
		...id(),
		unique: true,
	})
	public roomId: PaintChatRoom['id'];

	@ManyToOne(() => PaintChatRoom, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public room: PaintChatRoom | null;

	// 参加者1
	@Column({
		...id(),
	})
	public participant1Id: PaintChatParticipant['id'];

	@ManyToOne(() => PaintChatParticipant, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'participant1Id' })
	public participant1: PaintChatParticipant | null;

	// 参加者1の同意状態
	@Column('boolean', {
		default: false,
	})
	public participant1Agreed: boolean;

	// 参加者1の一言メッセージ（100文字以内）
	@Column('varchar', {
		length: 100,
		nullable: true,
	})
	public participant1Message: string | null;

	// 参加者2
	@Column({
		...id(),
	})
	public participant2Id: PaintChatParticipant['id'];

	@ManyToOne(() => PaintChatParticipant, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'participant2Id' })
	public participant2: PaintChatParticipant | null;

	// 参加者2の同意状態
	@Column('boolean', {
		default: false,
	})
	public participant2Agreed: boolean;

	// 参加者2の一言メッセージ（100文字以内）
	@Column('varchar', {
		length: 100,
		nullable: true,
	})
	public participant2Message: string | null;

	// 投稿完了日時
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public publishedAt: Date | null;

	// 投稿されたノートID
	@Column({
		...id(),
		nullable: true,
	})
	public noteId: string | null;
}
