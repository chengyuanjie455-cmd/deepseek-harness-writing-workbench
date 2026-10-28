export const auditCategories:Record<string,string>={account:'账号与登录',project:'项目与文件',model:'模型与渠道',generation:'生成与恢复',billing:'计费核对',runtime:'运行设置',access:'管理员查阅',other:'其他'};
export function auditCategory(action:string){
 if(/^(auth\.|user\.|platform\.)/.test(action))return 'account';
 if(/^admin\./.test(action))return 'access';
 if(/^billing\./.test(action))return 'billing';
 if(/^(concurrency\.|execution\.|backup\.|native\.(started|stopped|idle_|policy))/.test(action))return 'runtime';
 if(/^(chat\.(model|policy)|member\.models|model\.configuration|catalog\.|xiaopei\.|video\.(channel|model|storage|template)|image\.model|media\.model|release\.)/.test(action))return 'model';
 if(/^(project\.|change\.|file\.|tool\.project|chat\.(session|queue))/.test(action))return 'project';
 if(/^(pickup\.|image\.|native\.(video|image|pickup|prompt)|operations\.|task\.|model\.request|video\.quota|media\.)/.test(action))return 'generation';
 return 'other';
}
export const auditLabels:Record<string,string>={
 'auth.login':'登录平台','platform.setup':'初始化平台','user.create':'创建成员账号','user.update':'更新账号状态或权限',
 'project.create':'创建项目','project.create.preview':'预览新项目','project.directory.bind':'绑定项目目录','project.directory.preview':'预览项目目录','project.publish':'发布项目文件','project.recover':'恢复项目发布',
 'change.approve':'批准项目修改','change.reject':'退回项目修改','change.submit':'提交项目修改','chat.session.update':'更新聊天会话','chat.queue.edit':'修改排队消息','file.upload':'上传项目附件','tool.project_attach':'附加项目资料','tool.project_read':'读取项目资料',
 'chat.model.save':'保存文字模型','chat.models.sync':'同步模型目录','chat.policy.publish':'更新成员模型范围','member.models.update':'更新媒体模型范围','model.configuration.loaded':'加载模型配置','catalog.presentation.normalize':'整理模型目录','xiaopei.directory.sync':'同步小裴模型目录','release.publish':'发布流程模板',
 'video.channel.save':'保存视频渠道','video.channel.probe':'测试视频渠道','video.channel.capacity':'调整渠道容量','video.model.save':'保存视频模型','image.model.save':'保存图片模型','media.model.remove':'移除媒体模型','video.storage.save':'保存媒体存储设置','video.template.save':'保存视频提示词模板',
 'native.video.generate':'发起视频生成','native.image.generate':'发起图片生成','native.pickup.prepare':'准备补抽方案','native.prompt.receipt_retry':'恢复提示词回执','pickup.authorize_round':'提交补抽轮次','pickup.recover_original':'关联供应商原任务','pickup.human_adopt':'成员采用生成结果','pickup.dimensions_informational_recheck':'重新检查视频尺寸','image.authorize':'提交图片生成','image.original.upload':'上传原始图片','media.import':'导入生成媒体','model.request.recorded':'记录模型调用','operations.recover':'恢复原任务','task.cancel':'取消任务',
 'native.started':'启动成员环境','native.stopped':'停止成员环境','native.idle_sleep':'休眠空闲环境','native.idle_policy':'调整环境休眠时间','native.policy.update':'更新原生工作台设置','concurrency.update':'调整并发容量','execution.stop_verified':'核实执行器已停止','backup.restore':'恢复备份',
 'billing.bill.verify':'核对历史任务账单','billing.model.verify':'核对模型总账','billing.price.verify':'核对模型单价',
 'admin.chat.read':'管理员查阅聊天','admin.image.read':'管理员查阅图片任务','admin.media.read':'管理员查阅媒体','admin.model_usage.read':'管理员查阅模型用量','admin.pickup.read':'管理员查阅补抽任务','admin.pickups.list':'管理员查阅补抽列表','admin.sessions.list':'管理员查阅会话列表','admin.tasks.read':'管理员查阅任务列表',
 'request.close_unaccepted':'关闭未接收的请求','tool.sandbox_python.start':'启动项目脚本','tool.sandbox_python.completed':'完成项目脚本'
};
export const operationStates:Record<string,string>={ready:'结果已返回',adopted:'已采用',cancelled:'已取消',queued:'排队中',preparing:'准备中',submitting:'提交中',pending:'请求进行中',running:'处理中',downloading:'下载中',checking:'检查中',cancel_requested:'正在取消',submission_unknown:'提交结果待核对',unconfirmed:'用量待核对',failed:'执行失败',blocked:'执行受阻',download_failed:'下载失败',qa_failed:'结果检查未通过',interrupted:'执行中断',termination_unconfirmed:'执行器停止待核对',awaiting_candidate:'等待项目结果'};
export const operationKinds:Record<string,string>={'model-call':'文字调用','video-job':'视频任务','image-job':'图片任务',task:'项目任务'};
