/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { PaintChatRoom } from './PaintChatRoom.js';
import { PaintChatParticipant } from './PaintChatParticipant.js';

// テキストチャットメッセージ。システムメッセージ（お題、サイコロ）も含む。
@Entity('paint_chat_message')
export class PaintChatMessage {
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

	// 送信者（システムメッセージはNULL）
	@Column({
		...id(),
		nullable: true,
	})
	public participantId: PaintChatParticipant['id'] | null;

	@ManyToOne(() => PaintChatParticipant, {
		onDelete: 'SET NULL',
		nullable: true,
	})
	@JoinColumn()
	public participant: PaintChatParticipant | null;

	// メッセージ種別: text（通常）, topic（お題）, dice（サイコロ）, system（システム通知）
	@Column('varchar', {
		length: 16,
		default: 'text',
	})
	public type: 'text' | 'topic' | 'dice' | 'system';

	// メッセージ内容
	@Column('varchar', {
		length: 500,
	})
	public content: string;

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public createdAt: Date;
}
