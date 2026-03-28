/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { PaintChatRoom } from './PaintChatRoom.js';
import { PaintChatParticipant } from './PaintChatParticipant.js';

// 通報レコード
@Entity('paint_chat_report')
export class PaintChatReport {
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

	// 通報者（ラッパーID）
	@Column({
		...id(),
	})
	public reporterParticipantId: PaintChatParticipant['id'];

	// 通報者（実ユーザーID）
	@Column({
		...id(),
	})
	public reporterUserId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'reporterUserId' })
	public reporterUser: MiUser | null;

	// 被通報者（実ユーザーID）
	@Index()
	@Column({
		...id(),
	})
	public targetUserId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'targetUserId' })
	public targetUser: MiUser | null;

	// 通報理由
	@Column('varchar', {
		length: 1000,
		nullable: true,
	})
	public reason: string | null;

	// 対応状態: pending（未対応）, resolved（対応済み）, dismissed（却下）
	@Column('varchar', {
		length: 16,
		default: 'pending',
	})
	public status: 'pending' | 'resolved' | 'dismissed';

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public createdAt: Date;
}
