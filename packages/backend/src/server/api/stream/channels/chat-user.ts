/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import type { JsonObject } from '@/misc/json-value.js';
import { ChatService } from '@/core/ChatService.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class ChatUserChannel extends Channel {
	public readonly chName = 'chatUser';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:chat';
	private otherId: string;
	private typers: Record<string, Date> = {};
	private emitTypersIntervalId: ReturnType<typeof setInterval>;


	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private chatService: ChatService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		if (typeof params.otherId !== 'string') return false;
		if (!this.user) return false;
		if (params.otherId === this.user.id) return false;

		this.otherId = params.otherId;

		// IDをソートして統一的なチャンネル名を作成
		const sortedIds = [this.user!.id, this.otherId].sort();
		const channelName = `chatUserStream:${sortedIds[0]}-${sortedIds[1]}` as `chatUserStream:${string}-${string}`;
		this.subscriber.on(channelName, this.onEvent);

		return true;
	}

	@bindThis
	private async onEvent(data: GlobalEvents['chatUser']['payload']) {
		if (data.type === 'typing') {
			const userId = data.body.userId;
			const begin = this.typers[userId] == null;
			this.typers[userId] = new Date();
			// oranski方式のemitTypersは無効化し、個別イベントのみ使用
			// if (begin) {
			// 	this.emitTypers();
			// }
			// 個別typingイベントを送信
			this.send(data.type, data.body);
		} else if (data.type === 'typingStop') {
			const userId = data.body.userId;
			delete this.typers[userId];
			// oranski方式のemitTypersは無効化し、個別イベントのみ使用
			// this.emitTypers();
			// 個別typingStopイベントを送信
			this.send(data.type, data.body);
		} else {
			this.send(data.type, data.body);
		}
	}

	@bindThis
	public async onMessage(type: string, body: any) {
		// セキュリティ: ユーザー認証確認
		if (!this.user) {
			return;
		}

		switch (type) {
			case 'read':
				if (this.otherId) {
					this.chatService.readUserChatMessage(this.user.id, this.otherId);
				}
				break;
			case 'typing':
				// セキュリティ: typing送信者を認証済みユーザーIDに強制設定
				// フロントエンドからのuserIdパラメータは無視し、認証済みセッションのユーザーIDを使用
				if (this.otherId) {
					this.chatService.notifyUserTyping(this.user.id, this.otherId);
				}
				break;
			case 'typingStop':
				// セキュリティ: typingStop送信者を認証済みユーザーIDに強制設定
				// フロントエンドからのuserIdパラメータは無視し、認証済みセッションのユーザーIDを使用
				if (this.otherId) {
					this.chatService.notifyUserTypingStop(this.user.id, this.otherId);
				}
				break;

		}
	}

	@bindThis
	private async emitTypers() {
		const now = new Date();

		// 5秒以上経過したtyperを削除
		for (const [userId, date] of Object.entries(this.typers)) {
			if (now.getTime() - date.getTime() > 5000) delete this.typers[userId];
		}

		const typerUserIds = Object.keys(this.typers).filter(id => id !== this.user!.id);

		this.send('typing', {
			userIds: typerUserIds,
		});
	}

	@bindThis
	public dispose() {
		const actor = this.user;
		if (!actor) return;

		// IDをソートして統一的なチャンネル名を作成
		const sortedIds = [actor.id, this.otherId].sort();
		const channelName = `chatUserStream:${sortedIds[0]}-${sortedIds[1]}` as `chatUserStream:${string}-${string}`;
		this.subscriber.off(channelName, this.onEvent);
	}
}

