import { GlobalComment, Reaction } from '@/application/comment.type';
import { openCollabDB } from '@/application/db';
import {
  createRowDoc, deleteRowDoc,
  deleteView,
  getPageDoc,
  getPublishView,
  getPublishViewMeta,
  getUser, hasCollabCache,
  hasViewMetaCache,
} from '@/application/services/js-services/cache';
import { StrategyType } from '@/application/services/js-services/cache/types';
import {
  fetchPageCollab,
  fetchPublishView,
  fetchPublishViewMeta,
  fetchViewInfo,
} from '@/application/services/js-services/fetch';
import { APIService } from '@/application/services/js-services/http';
import { SyncManager } from '@/application/services/js-services/sync';

import { AFService, AFServiceConfig } from '@/application/services/services.type';
import { emit, EventType } from '@/application/session';
import { afterAuth, AUTH_CALLBACK_URL, withSignIn } from '@/application/session/sign_in';
import { getTokenParsed } from '@/application/session/token';
import {
  TemplateCategoryFormValues,
  TemplateCreatorFormValues,
  UploadTemplatePayload,
} from '@/application/template.type';
import {
  CreatePagePayload,
  CreateSpacePayload,
  CreateWorkspacePayload,
  DatabaseRelations,
  DuplicatePublishView,
  PublishViewPayload,
  QuickNoteEditorData,
  SubscriptionInterval,
  SubscriptionPlan,
  Types,
  UpdatePagePayload,
  UpdatePublishConfigPayload,
  UpdateSpacePayload,
  UpdateWorkspacePayload,
  UploadPublishNamespacePayload,
  WorkspaceMember,
  YjsEditorKey,
} from '@/application/types';
import { applyYDoc } from '@/application/ydoc/apply';
import { RepeatedChatMessage } from '@appflowyinc/ai-chat';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';

export class AFClientService implements AFService {
  private deviceId: string = nanoid(8);

  private clientId: string = 'web';

  private viewLoaded: Set<string> = new Set();

  private publishViewLoaded: Set<string> = new Set();

  private publishViewInfo: Map<
    string,
    {
      namespace: string;
      publishName: string;
    }
  > = new Map();

  constructor(config: AFServiceConfig) {
    APIService.initAPIService(config.cloudConfig);
  }

  getAxiosInstance() {
    return APIService.getAxiosInstance();
  }

  getClientId() {
    return this.clientId;
  }

  async publishView(workspaceId: string, viewId: string, payload?: PublishViewPayload) {
    if (this.publishViewInfo.has(viewId)) {
      this.publishViewInfo.delete(viewId);
    }

    return APIService.publishView(workspaceId, viewId, payload);
  }

  async unpublishView(workspaceId: string, viewId: string) {
    if (this.publishViewInfo.has(viewId)) {
      this.publishViewInfo.delete(viewId);
    }

    return APIService.unpublishView(workspaceId, viewId);
  }

  async updatePublishNamespace(workspaceId: string, payload: UploadPublishNamespacePayload) {
    this.publishViewInfo.clear();
    return APIService.updatePublishNamespace(workspaceId, payload);
  }

  async getPublishNamespace(workspaceId: string) {
    return APIService.getPublishNamespace(workspaceId);
  }

  async getPublishHomepage(workspaceId: string) {
    return APIService.getPublishHomepage(workspaceId);
  }

  async updatePublishHomepage(workspaceId: string, viewId: string) {
    return APIService.updatePublishHomepage(workspaceId, viewId);
  }

  async removePublishHomepage(workspaceId: string) {
    return APIService.removePublishHomepage(workspaceId);
  }

  async getPublishViewMeta(namespace: string, publishName: string) {
    const name = `${namespace}_${publishName}`;

    const isLoaded = this.publishViewLoaded.has(name);
    const viewMeta = await getPublishViewMeta(
      () => {
        return fetchPublishViewMeta(namespace, publishName);
      },
      {
        namespace,
        publishName,
      },
      isLoaded ? StrategyType.CACHE_FIRST : StrategyType.CACHE_AND_NETWORK,
    );

    if (!viewMeta) {
      return Promise.reject(new Error('View has not been published yet'));
    }

    return viewMeta;
  }

  async getPublishView(namespace: string, publishName: string) {
    const name = `${namespace}_${publishName}`;

    const isLoaded = this.publishViewLoaded.has(name);

    const { doc } = await getPublishView(
      async () => {
        try {
          return await fetchPublishView(namespace, publishName);
        } catch (e) {
          console.error(e);
          void (async () => {
            if (await hasViewMetaCache(name)) {
              this.publishViewLoaded.delete(name);
              void deleteView(name);
            }
          })();

          return Promise.reject(e);
        }
      },
      {
        namespace,
        publishName,
      },
      isLoaded ? StrategyType.CACHE_FIRST : StrategyType.CACHE_AND_NETWORK,
    );

    if (!isLoaded) {
      this.publishViewLoaded.add(name);
    }

    return doc;
  }

  async getPublishRowDocument(viewId: string) {
    const doc = await openCollabDB(viewId);

    if (hasCollabCache(doc)) {
      return doc;
    }

    return Promise.reject(new Error('Document not found'));

  }

  async createRowDoc(rowKey: string) {
    return createRowDoc(rowKey);
  }

  deleteRowDoc(rowKey: string) {
    return deleteRowDoc(rowKey);
  }

  async getAppDatabaseViewRelations(workspaceId: string, databaseStorageId: string) {

    const res = await APIService.getCollab(workspaceId, databaseStorageId, Types.WorkspaceDatabase);
    const doc = new Y.Doc();

    applyYDoc(doc, res.data);

    const { databases } = doc.getMap(YjsEditorKey.data_section).toJSON();
    const result: DatabaseRelations = {};

    databases.forEach((database: {
      database_id: string;
      views: string[]
    }) => {
      result[database.database_id] = database.views[0];
    });
    return result;
  }

  async getPublishInfo(viewId: string) {
    if (this.publishViewInfo.has(viewId)) {
      return this.publishViewInfo.get(viewId) as {
        namespace: string;
        publishName: string;
        publisherEmail: string;
        viewId: string;
        publishedAt: string;
        commentEnabled: boolean;
        duplicateEnabled: boolean;
      };
    }

    const info = await fetchViewInfo(viewId);

    const namespace = info.namespace;

    if (!namespace) {
      return Promise.reject(new Error('View not found'));
    }

    const data = {
      namespace,
      publishName: info.publish_name,
      publisherEmail: info.publisher_email,
      viewId: info.view_id,
      publishedAt: info.publish_timestamp,
      commentEnabled: info.comments_enabled,
      duplicateEnabled: info.duplicate_enabled,
    };

    this.publishViewInfo.set(viewId, data);

    return data;
  }

  async updatePublishConfig(workspaceId: string, config: UpdatePublishConfigPayload) {
    this.publishViewInfo.delete(config.view_id);
    return APIService.updatePublishConfig(workspaceId, config);
  }

  async getPublishOutline(namespace: string) {
    return APIService.getPublishOutline(namespace);
  }

  async getAppOutline(workspaceId: string) {
    return APIService.getAppOutline(workspaceId);
  }

  async getAppView(workspaceId: string, viewId: string) {
    return APIService.getView(workspaceId, viewId);
  }

  async getAppFavorites(workspaceId: string) {
    return APIService.getAppFavorites(workspaceId);
  }

  async getAppRecent(workspaceId: string) {
    return APIService.getAppRecent(workspaceId);
  }

  async getAppTrash(workspaceId: string) {
    return APIService.getAppTrash(workspaceId);
  }

  async loginAuth(url: string) {
    try {
      await APIService.signInWithUrl(url);
      emit(EventType.SESSION_VALID);
      afterAuth();
      return;
    } catch (e) {
      emit(EventType.SESSION_INVALID);
      return Promise.reject(e);
    }
  }

  @withSignIn()
  async signInMagicLink({ email }: { email: string; redirectTo: string }) {
    return await APIService.signInWithMagicLink(email, AUTH_CALLBACK_URL);
  }

  @withSignIn()
  async signInOTP(params: { email: string; code: string; redirectTo: string }) {
    return APIService.signInOTP(params);
  }

  @withSignIn()
  async signInGoogle(_: { redirectTo: string }) {
    return APIService.signInGoogle(AUTH_CALLBACK_URL);
  }

  @withSignIn()
  async signInApple(_: { redirectTo: string }) {
    return APIService.signInApple(AUTH_CALLBACK_URL);
  }

  @withSignIn()
  async signInGithub(_: { redirectTo: string }) {
    return APIService.signInGithub(AUTH_CALLBACK_URL);
  }

  @withSignIn()
  async signInDiscord(_: { redirectTo: string }) {
    return APIService.signInDiscord(AUTH_CALLBACK_URL);
  }

  @withSignIn()
  async signInKeycloak(_: { redirectTo: string }) {
    return APIService.signInKeycloak(AUTH_CALLBACK_URL);
  }

  async getWorkspaces() {
    const data = APIService.getWorkspaces();

    return data;
  }

  async getWorkspaceFolder(workspaceId: string) {
    const data = await APIService.getWorkspaceFolder(workspaceId);

    return data;
  }

  async getCurrentUser() {
    const token = getTokenParsed();
    const userId = token?.user?.id;

    const user = await getUser(
      () => APIService.getCurrentUser(),
      userId,
      StrategyType.CACHE_AND_NETWORK,
    );

    if (!user) {
      return Promise.reject(new Error('User not found'));
    }

    return user;
  }

  async openWorkspace(workspaceId: string) {
    return APIService.openWorkspace(workspaceId);
  }

  async createWorkspace(payload: CreateWorkspacePayload) {
    return APIService.createWorkspace(payload);
  }

  async updateWorkspace(workspaceId: string, payload: UpdateWorkspacePayload) {
    return APIService.updateWorkspace(workspaceId, payload);
  }

  async getUserWorkspaceInfo() {
    const workspaceInfo = await APIService.getUserWorkspaceInfo();

    if (!workspaceInfo) {
      return Promise.reject(new Error('Workspace info not found'));
    }

    return {
      userId: workspaceInfo.user_id,
      selectedWorkspace: workspaceInfo.selected_workspace,
      workspaces: workspaceInfo.workspaces,
    };
  }

  async duplicatePublishView(params: DuplicatePublishView) {
    return APIService.duplicatePublishView(params.workspaceId, {
      dest_view_id: params.spaceViewId,
      published_view_id: params.viewId,
      published_collab_type: params.collabType,
    });
  }

  createCommentOnPublishView(viewId: string, content: string, replyCommentId: string | undefined): Promise<void> {
    return APIService.createGlobalCommentOnPublishView(viewId, content, replyCommentId);
  }

  deleteCommentOnPublishView(viewId: string, commentId: string): Promise<void> {
    return APIService.deleteGlobalCommentOnPublishView(viewId, commentId);
  }

  getPublishViewGlobalComments(viewId: string): Promise<GlobalComment[]> {
    return APIService.getPublishViewComments(viewId);
  }

  getPublishViewReactions(viewId: string, commentId?: string): Promise<Record<string, Reaction[]>> {
    return APIService.getReactions(viewId, commentId);
  }

  addPublishViewReaction(viewId: string, commentId: string, reactionType: string): Promise<void> {
    return APIService.addReaction(viewId, commentId, reactionType);
  }

  removePublishViewReaction(viewId: string, commentId: string, reactionType: string): Promise<void> {
    return APIService.removeReaction(viewId, commentId, reactionType);
  }

  async getTemplateCategories() {
    return APIService.getTemplateCategories();
  }

  async getTemplateCreators() {
    return APIService.getTemplateCreators();
  }

  async createTemplate(template: UploadTemplatePayload) {
    return APIService.createTemplate(template);
  }

  async updateTemplate(id: string, template: UploadTemplatePayload) {
    return APIService.updateTemplate(id, template);
  }

  async getTemplateById(id: string) {
    return APIService.getTemplateById(id);
  }

  async getTemplates(params: {
    categoryId?: string;
    nameContains?: string;
  }) {
    return APIService.getTemplates(params);
  }

  async deleteTemplate(id: string) {
    return APIService.deleteTemplate(id);
  }

  async addTemplateCategory(category: TemplateCategoryFormValues) {
    return APIService.addTemplateCategory(category);
  }

  async updateTemplateCategory(categoryId: string, category: TemplateCategoryFormValues) {
    return APIService.updateTemplateCategory(categoryId, category);
  }

  async deleteTemplateCategory(categoryId: string) {
    return APIService.deleteTemplateCategory(categoryId);
  }

  async updateTemplateCreator(creatorId: string, creator: TemplateCreatorFormValues) {
    return APIService.updateTemplateCreator(creatorId, creator);
  }

  async createTemplateCreator(creator: TemplateCreatorFormValues) {
    return APIService.createTemplateCreator(creator);
  }

  async deleteTemplateCreator(creatorId: string) {
    return APIService.deleteTemplateCreator(creatorId);
  }

  async uploadTemplateAvatar(file: File) {
    return APIService.uploadTemplateAvatar(file);
  }

  async getPageDoc(workspaceId: string, viewId: string, errorCallback?: (error: {
    code: number;
  }) => void) {

    const token = getTokenParsed();
    const userId = token?.user.id;

    if (!userId) {
      throw new Error('User not found');
    }

    const name = `${userId}_${workspaceId}_${viewId}`;

    const isLoaded = this.viewLoaded.has(name);

    const { doc } = await getPageDoc(
      async () => {
        try {
          return await fetchPageCollab(workspaceId, viewId);
          // eslint-disable-next-line
        } catch (e: any) {
          console.error(e);

          errorCallback?.(e);
          void (async () => {
            this.viewLoaded.delete(name);
            void deleteView(name);
          })();

          return Promise.reject(e);
        }
      },
      name,
      isLoaded ? StrategyType.CACHE_FIRST : StrategyType.CACHE_AND_NETWORK,
    );

    if (!isLoaded) {
      this.viewLoaded.add(name);
    }

    return doc;
  }

  async getInvitation(invitationId: string) {
    return APIService.getInvitation(invitationId);
  }

  async acceptInvitation(invitationId: string) {
    return APIService.acceptInvitation(invitationId);
  }

  approveRequestAccess(requestId: string): Promise<void> {
    return APIService.approveRequestAccess(requestId);
  }

  getRequestAccessInfo(requestId: string) {
    return APIService.getRequestAccessInfo(requestId);
  }

  sendRequestAccess(workspaceId: string, viewId: string): Promise<void> {
    return APIService.sendRequestAccess(workspaceId, viewId);
  }

  getSubscriptionLink(workspaceId: string, plan: SubscriptionPlan, interval: SubscriptionInterval) {
    return APIService.getSubscriptionLink(workspaceId, plan, interval);
  }

  cancelSubscription(workspaceId: string, plan: SubscriptionPlan, reason?: string) {
    return APIService.cancelSubscription(workspaceId, plan, reason);
  }

  getSubscriptions() {
    return APIService.getSubscriptions();
  }

  getActiveSubscription(workspaceId: string) {
    return APIService.getActiveSubscription(workspaceId);
  }

  getWorkspaceSubscriptions(workspaceId: string) {
    return APIService.getWorkspaceSubscriptions(workspaceId);
  }

  registerDocUpdate(doc: Y.Doc, context: {
    workspaceId: string, objectId: string, collabType: Types
  }) {
    const token = getTokenParsed();
    const userId = token?.user.id;

    if (!userId) {
      throw new Error('User not found');
    }

    const sync = new SyncManager(doc, { userId, ...context });

    sync.initialize();
  }

  async importFile(file: File, onProgress: (progress: number) => void) {
    const task = await APIService.createImportTask(file);

    await APIService.uploadImportFile(task.presignedUrl, file, onProgress);
  }

  async createSpace(workspaceId: string, payload: CreateSpacePayload) {
    return APIService.createSpace(workspaceId, payload);
  }

  async updateSpace(workspaceId: string, payload: UpdateSpacePayload) {
    return APIService.updateSpace(workspaceId, payload);
  }

  async addAppPage(workspaceId: string, parentViewId: string, payload: CreatePagePayload) {
    return APIService.addAppPage(workspaceId, parentViewId, payload);
  }

  async updateAppPage(workspaceId: string, viewId: string, data: UpdatePagePayload) {
    return APIService.updatePage(workspaceId, viewId, data);
  }

  async duplicateAppPage(workspaceId: string, viewId: string) {
    return APIService.duplicatePage(workspaceId, viewId);
  }

  async deleteTrash(workspaceId: string, viewId?: string) {
    return APIService.deleteTrash(workspaceId, viewId);
  }

  async moveToTrash(workspaceId: string, viewId: string) {
    return APIService.moveToTrash(workspaceId, viewId);
  }

  async restoreFromTrash(workspaceId: string, viewId?: string) {
    return APIService.restorePage(workspaceId, viewId);
  }

  async movePage(workspaceId: string, viewId: string, parentId: string, prevViewId?: string) {
    return APIService.movePageTo(workspaceId, viewId, parentId, prevViewId);
  }

  async uploadFile(workspaceId: string, viewId: string, file: File, onProgress?: (progress: number) => void) {
    return APIService.uploadFile(workspaceId, viewId, file, onProgress);
  }

  deleteWorkspace(workspaceId: string): Promise<void> {
    return APIService.deleteWorkspace(workspaceId);
  }

  leaveWorkspace(workspaceId: string): Promise<void> {
    return APIService.leaveWorkspace(workspaceId);
  }

  inviteMembers(workspaceId: string, emails: string[]): Promise<void> {
    return APIService.inviteMembers(workspaceId, emails);
  }

  getWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return APIService.getMembers(workspaceId);
  }

  getQuickNoteList(workspaceId: string, params: {
    offset?: number;
    limit?: number;
    searchTerm?: string;
  }) {
    return APIService.getQuickNoteList(workspaceId, params);
  }

  createQuickNote(workspaceId: string, data: QuickNoteEditorData[]) {
    return APIService.createQuickNote(workspaceId, data);
  }

  updateQuickNote(workspaceId: string, id: string, data: QuickNoteEditorData[]) {
    return APIService.updateQuickNote(workspaceId, id, data);
  }

  deleteQuickNote(workspaceId: string, id: string) {
    return APIService.deleteQuickNote(workspaceId, id);
  }

  searchWorkspace(workspaceId: string, query: string) {
    return APIService.searchWorkspace(workspaceId, query);
  }

  async getChatMessages(
    workspaceId: string,
    chatId: string,
    limit?: number | undefined,
  ): Promise<RepeatedChatMessage> {
    return APIService.getChatMessages(workspaceId, chatId, limit);
  }

  async joinWorkspaceByInvitationCode(code: string) {
    return APIService.joinWorkspaceByInvitationCode(code);
  }

  async getWorkspaceInfoByInvitationCode(code: string) {
    return APIService.getWorkspaceInfoByInvitationCode(code);
  }
}
