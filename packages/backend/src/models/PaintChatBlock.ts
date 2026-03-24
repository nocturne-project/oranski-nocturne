/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne, Unique } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

// 再マッチング除外リスト。通報関係にあるユーザーペア。
@Entity('paint_chat_block')
@Unique(['reporterUserId', 'targetUserId'])
export class PaintChatBlock {
	@PrimaryColumn(id())
	public id: string;

	// 通報者
	@Index()
	@Column({
		...id(),
	})
	public reporterUserId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'reporterUserId' })
	public reporterUser: MiUser | null;

	// 被通報者
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

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public createdAt: Date;
}
