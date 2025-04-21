import { callPopup, eventSource, event_types, getCurrentChatId, getRequestHeaders, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import { escapeRegex, uuidv4 } from '../../utils.js';

/**
 * @typedef {Object} TagBlockerTag
 * @property {string} id 唯一ID
 * @property {string} startTag 开始标签
 * @property {string} endTag 结束标签
 * @property {boolean} enabled 是否启用
 * @property {number|null} minDepth 最小楼层 (null表示不限制)
 * @property {number|null} maxDepth 最大楼层 (null表示不限制)
 * @property {boolean} markdownOnly 是否仅在Markdown中应用
 * @property {boolean} promptOnly 是否仅在提示中应用
 * @property {boolean} runOnEdit 是否在编辑时应用
 * @property {number[]} placement 应用位置 (0=用户输入, 1=AI响应, 2=系统提示)
 * @property {string|null} regexPattern 正则表达式模式 (null表示使用标签模式)
 * @property {string} replaceString 替换文本
 * @property {string} scriptName 规则名称
 * @property {number} substituteRegex 替换方式 (0=替换匹配项, 1=保留匹配项)
 */

/**
 * @typedef {Object} TagBlockerExcludedPrompt
 * @property {string} id 唯一ID
 * @property {string} text prompt文本
 * @property {boolean} excluded 是否排除
 * @property {string} source 来源信息
 */

// 初始化扩展设置
if (!extension_settings.tag_blocker) {
    extension_settings.tag_blocker = {
        tags: [],
        excludedPrompts: [],
        autoRefresh: true,
        debugMode: false
    };
}

// 确保兼容旧版本格式
extension_settings.tag_blocker.tags.forEach(tag => {
    // 添加新字段的默认值
    if (tag.minDepth === undefined) tag.minDepth = null;
    if (tag.maxDepth === undefined) tag.maxDepth = null;
    if (tag.markdownOnly === undefined) tag.markdownOnly = false;
    if (tag.promptOnly === undefined) tag.promptOnly = true;
    if (tag.runOnEdit === undefined) tag.runOnEdit = true;
    if (tag.placement === undefined) tag.placement = [2]; // 默认为系统提示
    if (tag.regexPattern === undefined) tag.regexPattern = null;
    if (tag.replaceString === undefined) tag.replaceString = '';
    if (tag.scriptName === undefined) tag.scriptName = `规则 ${tag.startTag}...${tag.endTag}`;
    if (tag.substituteRegex === undefined) tag.substituteRegex = 0;
});

/**
 * 保存标签屏蔽器设置
 */
function saveTagBlockerSettings() {
    saveSettingsDebounced();
}

/**
 * 记录调试信息
 * @param {string} message 
 * @param {any} data 
 */
function logDebug(message, data = null) {
    if (extension_settings.tag_blocker.debugMode) {
        if (data) {
            console.log(`[高级内容处理器] ${message}`, data);
        } else {
            console.log(`[高级内容处理器] ${message}`);
        }
    }
}

/**
 * 创建替换规则的预览文本
 * @param {TagBlockerTag} tag 
 * @returns {string}
 */
function createTagPreview(tag) {
    let preview = '';
    
    if (tag.regexPattern) {
        // 正则模式预览
        preview = `正则: ${tag.regexPattern} → ${tag.replaceString || '(移除)'}`;
    } else {
        // 标签模式预览
        preview = `${tag.startTag}...${tag.endTag}`;
    }
    
    // 楼层限制
    let depthLimit = '';
    if (tag.minDepth !== null && tag.maxDepth !== null) {
        depthLimit = `楼层 ${tag.minDepth}-${tag.maxDepth}`;
    } else if (tag.minDepth !== null) {
        depthLimit = `>${tag.minDepth}楼`;
    } else if (tag.maxDepth !== null) {
        depthLimit = `<${tag.maxDepth}楼`;
    }
    
    // 应用位置
    let placementText = [];
    if (tag.placement.includes(0)) placementText.push('用户');
    if (tag.placement.includes(1)) placementText.push('AI');
    if (tag.placement.includes(2)) placementText.push('系统');
    
    let restrictions = [];
    if (depthLimit) restrictions.push(depthLimit);
    if (tag.markdownOnly) restrictions.push('仅MD');
    if (tag.promptOnly) restrictions.push('仅提示');
    if (placementText.length > 0) restrictions.push(placementText.join('/'));
    
    if (restrictions.length > 0) {
        preview += ` [${restrictions.join(', ')}]`;
    }
    
    return preview;
}

/**
 * 导入脚本文件到标签列表
 * @param {Object} scriptData 脚本数据
 * @returns {TagBlockerTag}
 */
function importScriptToTag(scriptData) {
    // 创建新规则
    const newTag = {
        id: scriptData.id || uuidv4(),
        scriptName: scriptData.scriptName || '导入的脚本',
        // 正则相关
        regexPattern: scriptData.findRegex || null,
        replaceString: scriptData.replaceString || '',
        // 标签相关
        startTag: '',
        endTag: '',
        // 限制条件
        minDepth: scriptData.minDepth !== undefined ? scriptData.minDepth : null,
        maxDepth: scriptData.maxDepth !== undefined ? scriptData.maxDepth : null,
        markdownOnly: !!scriptData.markdownOnly,
        promptOnly: scriptData.promptOnly !== undefined ? scriptData.promptOnly : true,
        runOnEdit: scriptData.runOnEdit !== undefined ? scriptData.runOnEdit : true,
        placement: Array.isArray(scriptData.placement) ? scriptData.placement : [2],
        substituteRegex: scriptData.substituteRegex !== undefined ? scriptData.substituteRegex : 0,
        enabled: scriptData.disabled !== undefined ? !scriptData.disabled : true
    };
    
    return newTag;
}

/**
 * 获取消息在对话中的楼层（深度）
 * @param {string} messageText 消息文本
 * @returns {number|null} 消息的楼层，如果找不到则返回null
 */
function getMessageDepth(messageText) {
    const context = getContext();
    if (!context || !context.chat || !Array.isArray(context.chat)) {
        return null;
    }
    
    const index = context.chat.findIndex(message => message.mes === messageText);
    if (index === -1) return null;
    
    return index;
}

/**
 * 根据正则表达式处理文本
 * @param {string} text 原始文本
 * @param {string} regexStr 正则表达式字符串
 * @param {string} replaceStr 替换字符串
 * @returns {string} 处理后的文本
 */
function processWithRegex(text, regexStr, replaceStr) {
    try {
        // 提取正则表达式的标志
        let flags = '';
        const lastSlashIndex = regexStr.lastIndexOf('/');
        if (lastSlashIndex > 0) {
            flags = regexStr.substring(lastSlashIndex + 1);
            regexStr = regexStr.substring(1, lastSlashIndex);
        } else {
            // 如果没有斜杠，尝试按原样解析
            if (regexStr.startsWith('/')) {
                regexStr = regexStr.substring(1);
            }
        }
        
        const regex = new RegExp(regexStr, flags);
        return text.replace(regex, replaceStr);
    } catch (error) {
        console.error("正则表达式处理错误:", error);
        return text; // 出错时返回原始文本
    }
}

/**
 * 使用标签对文本进行处理
 * @param {string} text 原始文本
 * @param {string} startTag 开始标签
 * @param {string} endTag 结束标签
 * @param {string} replaceStr 替换文本
 * @returns {string} 处理后的文本
 */
function processWithTags(text, startTag, endTag, replaceStr) {
    const startTagEscaped = escapeRegex(startTag);
    const endTagEscaped = escapeRegex(endTag);
    
    // 创建正则表达式匹配标签内容
    const regex = new RegExp(`${startTagEscaped}(.*?)${endTagEscaped}`, 'gs');
    
    // 替换标签内容
    return text.replace(regex, replaceStr);
}

/**
 * 加载标签列表
 */
async function loadTagList() {
    const tagList = $('#tag-list');
    tagList.empty();

    const tagTemplate = $(await renderExtensionTemplateAsync('tag-blocker', 'tagTemplate'));

    extension_settings.tag_blocker.tags.forEach(tag => {
        const tagItem = tagTemplate.clone();
        
        tagItem.attr('id', tag.id);
        tagItem.find('.tag-name').text(tag.scriptName || `规则 ${tag.id.substring(0, 6)}`);
        
        // 显示规则详情
        const details = createTagPreview(tag);
        tagItem.find('.tag-details').text(details);
        
        // 添加不同类型的样式
        if (tag.regexPattern) {
            tagItem.addClass('tag-regex-item');
        }
        
        const enabledCheckbox = tagItem.find('.tag-enabled');
        enabledCheckbox.prop('checked', tag.enabled);
        
        if (!tag.enabled) {
            tagItem.addClass('disabled');
            tagItem.find('.enable-icon').hide();
            tagItem.find('.disable-icon').show();
        }

        // 启用/禁用标签
        enabledCheckbox.on('change', function() {
            const checked = $(this).prop('checked');
            tag.enabled = checked;
            
            if (checked) {
                tagItem.removeClass('disabled');
                tagItem.find('.enable-icon').show();
                tagItem.find('.disable-icon').hide();
            } else {
                tagItem.addClass('disabled');
                tagItem.find('.enable-icon').hide();
                tagItem.find('.disable-icon').show();
            }
            
            saveTagBlockerSettings();
        });

        // 编辑标签
        tagItem.find('.edit-tag').on('click', function() {
            if (tag.regexPattern) {
                onEditRegexClick(tag.id);
            } else {
                onEditTagClick(tag.id);
            }
        });

        // 删除标签
        tagItem.find('.delete-tag').on('click', function() {
            onDeleteTagClick(tag.id);
        });

        tagList.append(tagItem);
    });
}

/**
 * 加载Prompt列表
 */
async function loadPromptList() {
    const promptList = $('#prompt-list');
    promptList.empty();

    const promptTemplate = $(await renderExtensionTemplateAsync('tag-blocker', 'promptTemplate'));

    extension_settings.tag_blocker.excludedPrompts.forEach(prompt => {
        const promptItem = promptTemplate.clone();
        
        promptItem.attr('id', prompt.id);
        // 截短显示
        let displayText = prompt.text;
        if (displayText.length > 100) {
            displayText = displayText.substring(0, 97) + '...';
        }
        promptItem.find('.prompt-text').text(displayText);
        promptItem.attr('title', prompt.text);
        
        // 显示来源信息
        if (prompt.source) {
            promptItem.find('.prompt-source').text(`来源: ${prompt.source}`);
        }
        
        const excludedCheckbox = promptItem.find('.prompt-excluded');
        excludedCheckbox.prop('checked', prompt.excluded);
        
        if (prompt.excluded) {
            promptItem.addClass('excluded');
            promptItem.find('.include-icon').show();
            promptItem.find('.exclude-icon').hide();
        }

        // 排除/包含Prompt
        excludedCheckbox.on('change', function() {
            const checked = $(this).prop('checked');
            prompt.excluded = checked;
            
            if (checked) {
                promptItem.addClass('excluded');
                promptItem.find('.include-icon').show();
                promptItem.find('.exclude-icon').hide();
            } else {
                promptItem.removeClass('excluded');
                promptItem.find('.include-icon').hide();
                promptItem.find('.exclude-icon').show();
            }
            
            saveTagBlockerSettings();
        });

        promptList.append(promptItem);
    });
}

/**
 * 添加新标签
 */
async function onAddTagClick() {
    const editorHtml = $(await renderExtensionTemplateAsync('tag-blocker', 'editor'));
    
    // 初始化编辑器
    editorHtml.find('#regex-pattern').parent().parent().hide(); // 隐藏正则输入框
    
    // 预览
    editorHtml.find('#tag-start, #tag-end').on('input', function() {
        const startTag = editorHtml.find('#tag-start').val();
        const endTag = editorHtml.find('#tag-end').val();
        
        editorHtml.find('.tag-start-preview').text(startTag);
        editorHtml.find('.tag-end-preview').text(endTag);
    });

    const popupResult = await callPopup(editorHtml, 'confirm');
    if (popupResult) {
        const startTag = editorHtml.find('#tag-start').val();
        const endTag = editorHtml.find('#tag-end').val();
        const replaceString = editorHtml.find('#replace-string').val();
        const minDepth = editorHtml.find('#min-depth').val() ? parseInt(editorHtml.find('#min-depth').val()) : null;
        const maxDepth = editorHtml.find('#max-depth').val() ? parseInt(editorHtml.find('#max-depth').val()) : null;
        const markdownOnly = editorHtml.find('#markdown-only').prop('checked');
        const promptOnly = editorHtml.find('#prompt-only').prop('checked');
        const runOnEdit = editorHtml.find('#run-on-edit').prop('checked');
        
        // 获取应用位置选项
        const placement = [];
        editorHtml.find('.placement-option:checked').each(function() {
            placement.push(parseInt($(this).val()));
        });
        
        if (!startTag || !endTag) {
            window.toastr?.warning?.('开始标签和结束标签不能为空');
            return;
        }
        
        const newTag = {
            id: uuidv4(),
            scriptName: `标签 ${startTag}...${endTag}`,
            startTag: startTag,
            endTag: endTag,
            regexPattern: null,
            replaceString: replaceString,
            minDepth: minDepth,
            maxDepth: maxDepth,
            markdownOnly: markdownOnly,
            promptOnly: promptOnly,
            runOnEdit: runOnEdit,
            placement: placement.length > 0 ? placement : [2],
            substituteRegex: 0,
            enabled: true
        };
        
        extension_settings.tag_blocker.tags.push(newTag);
        saveTagBlockerSettings();
        await loadTagList();
    }
}

/**
 * 添加新的正则表达式规则
 */
async function onAddRegexClick() {
    const editorHtml = $(await renderExtensionTemplateAsync('tag-blocker', 'editor'));
    
    // 初始化编辑器
    editorHtml.find('#tag-start').parent().parent().hide(); // 隐藏标签输入框
    editorHtml.find('#tag-end').parent().parent().hide(); // 隐藏标签输入框
    editorHtml.find('.tag-preview').hide(); // 隐藏预览
    
    const popupResult = await callPopup(editorHtml, 'confirm');
    if (popupResult) {
        const regexPattern = editorHtml.find('#regex-pattern').val();
        const replaceString = editorHtml.find('#replace-string').val();
        const minDepth = editorHtml.find('#min-depth').val() ? parseInt(editorHtml.find('#min-depth').val()) : null;
        const maxDepth = editorHtml.find('#max-depth').val() ? parseInt(editorHtml.find('#max-depth').val()) : null;
        const markdownOnly = editorHtml.find('#markdown-only').prop('checked');
        const promptOnly = editorHtml.find('#prompt-only').prop('checked');
        const runOnEdit = editorHtml.find('#run-on-edit').prop('checked');
        
        // 获取应用位置选项
        const placement = [];
        editorHtml.find('.placement-option:checked').each(function() {
            placement.push(parseInt($(this).val()));
        });
        
        if (!regexPattern) {
            window.toastr?.warning?.('正则表达式不能为空');
            return;
        }
        
        const newTag = {
            id: uuidv4(),
            scriptName: `正则 ${regexPattern.substring(0, 20)}${regexPattern.length > 20 ? '...' : ''}`,
            startTag: '',
            endTag: '',
            regexPattern: regexPattern,
            replaceString: replaceString,
            minDepth: minDepth,
            maxDepth: maxDepth,
            markdownOnly: markdownOnly,
            promptOnly: promptOnly,
            runOnEdit: runOnEdit,
            placement: placement.length > 0 ? placement : [2],
            substituteRegex: 0,
            enabled: true
        };
        
        extension_settings.tag_blocker.tags.push(newTag);
        saveTagBlockerSettings();
        await loadTagList();
    }
}

/**
 * 导入脚本文件
 */
async function onImportScriptClick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = async function(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = async function(e) {
            try {
                const scriptData = JSON.parse(e.target.result);
                
                // 检查是否有必要的字段
                if (!scriptData.findRegex && (!scriptData.startTag || !scriptData.endTag)) {
                    window.toastr?.error?.('无效的脚本文件，缺少必要的字段');
                    return;
                }
                
                const newTag = importScriptToTag(scriptData);
                extension_settings.tag_blocker.tags.push(newTag);
                saveTagBlockerSettings();
                await loadTagList();
                
                window.toastr?.success?.(`成功导入脚本: ${newTag.scriptName}`);
            } catch (error) {
                console.error("导入脚本出错:", error);
                window.toastr?.error?.('导入脚本失败: ' + error.message);
            }
        };
        reader.readAsText(file);
    };
    
    input.click();
}

/**
 * 导出所有规则
 */
async function onExportRulesClick() {
    const rules = extension_settings.tag_blocker.tags;
    if (!rules || rules.length === 0) {
        window.toastr?.warning?.('没有可导出的规则');
        return;
    }
    
    // 转换为导出格式
    const exportData = rules.map(rule => {
        return {
            id: rule.id,
            scriptName: rule.scriptName,
            findRegex: rule.regexPattern,
            replaceString: rule.replaceString,
            trimStrings: [],
            placement: rule.placement,
            disabled: !rule.enabled,
            markdownOnly: rule.markdownOnly,
            promptOnly: rule.promptOnly,
            runOnEdit: rule.runOnEdit,
            substituteRegex: rule.substituteRegex,
            minDepth: rule.minDepth,
            maxDepth: rule.maxDepth
        };
    });
    
    // 创建下载
    const dataStr = JSON.stringify(exportData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    
    const link = document.createElement('a');
    link.download = 'tag_blocker_rules.json';
    link.href = url;
    link.click();
    
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 100);
}

/**
 * 编辑现有标签
 * @param {string} tagId 标签ID
 */
async function onEditTagClick(tagId) {
    const tag = extension_settings.tag_blocker.tags.find(t => t.id === tagId);
    if (!tag) return;
    
    const editorHtml = $(await renderExtensionTemplateAsync('tag-blocker', 'editor'));
    
    // 隐藏正则字段
    editorHtml.find('#regex-pattern').parent().parent().hide();
    
    // 填充表单
    editorHtml.find('#tag-start').val(tag.startTag);
    editorHtml.find('#tag-end').val(tag.endTag);
    editorHtml.find('#replace-string').val(tag.replaceString);
    
    if (tag.minDepth !== null) editorHtml.find('#min-depth').val(tag.minDepth);
    if (tag.maxDepth !== null) editorHtml.find('#max-depth').val(tag.maxDepth);
    
    editorHtml.find('#markdown-only').prop('checked', tag.markdownOnly);
    editorHtml.find('#prompt-only').prop('checked', tag.promptOnly);
    editorHtml.find('#run-on-edit').prop('checked', tag.runOnEdit);
    
    // 设置位置选项
    if (Array.isArray(tag.placement)) {
        tag.placement.forEach(pos => {
            editorHtml.find(`.placement-option[value="${pos}"]`).prop('checked', true);
        });
    }
    
    // 更新预览
    editorHtml.find('.tag-start-preview').text(tag.startTag);
    editorHtml.find('.tag-end-preview').text(tag.endTag);
    
    editorHtml.find('#tag-start, #tag-end').on('input', function() {
        const startTag = editorHtml.find('#tag-start').val();
        const endTag = editorHtml.find('#tag-end').val();
        
        editorHtml.find('.tag-start-preview').text(startTag);
        editorHtml.find('.tag-end-preview').text(endTag);
    });

    const popupResult = await callPopup(editorHtml, 'confirm');
    if (popupResult) {
        const startTag = editorHtml.find('#tag-start').val();
        const endTag = editorHtml.find('#tag-end').val();
        const replaceString = editorHtml.find('#replace-string').val();
        const minDepth = editorHtml.find('#min-depth').val() ? parseInt(editorHtml.find('#min-depth').val()) : null;
        const maxDepth = editorHtml.find('#max-depth').val() ? parseInt(editorHtml.find('#max-depth').val()) : null;
        const markdownOnly = editorHtml.find('#markdown-only').prop('checked');
        const promptOnly = editorHtml.find('#prompt-only').prop('checked');
        const runOnEdit = editorHtml.find('#run-on-edit').prop('checked');
        
        // 获取应用位置选项
        const placement = [];
        editorHtml.find('.placement-option:checked').each(function() {
            placement.push(parseInt($(this).val()));
        });
        
        if (!startTag || !endTag) {
            window.toastr?.warning?.('开始标签和结束标签不能为空');
            return;
        }
        
        tag.scriptName = `标签 ${startTag}...${endTag}`;
        tag.startTag = startTag;
        tag.endTag = endTag;
        tag.replaceString = replaceString;
        tag.minDepth = minDepth;
        tag.maxDepth = maxDepth;
        tag.markdownOnly = markdownOnly;
        tag.promptOnly = promptOnly;
        tag.runOnEdit = runOnEdit;
        tag.placement = placement.length > 0 ? placement : [2];
        
        saveTagBlockerSettings();
        await loadTagList();
    }
}

/**
 * 编辑正则表达式规则
 * @param {string} tagId 规则ID
 */
async function onEditRegexClick(tagId) {
    const tag = extension_settings.tag_blocker.tags.find(t => t.id === tagId);
    if (!tag) return;
    
    const editorHtml = $(await renderExtensionTemplateAsync('tag-blocker', 'editor'));
    
    // 隐藏标签字段
    editorHtml.find('#tag-start').parent().parent().hide();
    editorHtml.find('#tag-end').parent().parent().hide();
    editorHtml.find('.tag-preview').hide();
    
    // 填充表单
    editorHtml.find('#regex-pattern').val(tag.regexPattern);
    editorHtml.find('#replace-string').val(tag.replaceString);
    
    if (tag.minDepth !== null) editorHtml.find('#min-depth').val(tag.minDepth);
    if (tag.maxDepth !== null) editorHtml.find('#max-depth').val(tag.maxDepth);
    
    editorHtml.find('#markdown-only').prop('checked', tag.markdownOnly);
    editorHtml.find('#prompt-only').prop('checked', tag.promptOnly);
    editorHtml.find('#run-on-edit').prop('checked', tag.runOnEdit);
    
    // 设置位置选项
    if (Array.isArray(tag.placement)) {
        tag.placement.forEach(pos => {
            editorHtml.find(`.placement-option[value="${pos}"]`).prop('checked', true);
        });
    }

    const popupResult = await callPopup(editorHtml, 'confirm');
    if (popupResult) {
        const regexPattern = editorHtml.find('#regex-pattern').val();
        const replaceString = editorHtml.find('#replace-string').val();
        const minDepth = editorHtml.find('#min-depth').val() ? parseInt(editorHtml.find('#min-depth').val()) : null;
        const maxDepth = editorHtml.find('#max-depth').val() ? parseInt(editorHtml.find('#max-depth').val()) : null;
        const markdownOnly = editorHtml.find('#markdown-only').prop('checked');
        const promptOnly = editorHtml.find('#prompt-only').prop('checked');
        const runOnEdit = editorHtml.find('#run-on-edit').prop('checked');
        
        // 获取应用位置选项
        const placement = [];
        editorHtml.find('.placement-option:checked').each(function() {
            placement.push(parseInt($(this).val()));
        });
        
        if (!regexPattern) {
            window.toastr?.warning?.('正则表达式不能为空');
            return;
        }
        
        tag.scriptName = `正则 ${regexPattern.substring(0, 20)}${regexPattern.length > 20 ? '...' : ''}`;
        tag.regexPattern = regexPattern;
        tag.replaceString = replaceString;
        tag.minDepth = minDepth;
        tag.maxDepth = maxDepth;
        tag.markdownOnly = markdownOnly;
        tag.promptOnly = promptOnly;
        tag.runOnEdit = runOnEdit;
        tag.placement = placement.length > 0 ? placement : [2];
        
        saveTagBlockerSettings();
        await loadTagList();
    }
}

/**
 * 删除标签
 * @param {string} tagId 标签ID
 */
async function onDeleteTagClick(tagId) {
    const confirmed = await callGenericPopup('确定要删除这个规则吗？', POPUP_TYPE.CONFIRM);
    if (!confirmed) return;
    
    const index = extension_settings.tag_blocker.tags.findIndex(t => t.id === tagId);
    if (index !== -1) {
        extension_settings.tag_blocker.tags.splice(index, 1);
        saveTagBlockerSettings();
        await loadTagList();
    }
}

/**
 * 扫描当前对话的所有Prompt
 */
async function scanPrompts() {
    // 获取当前对话ID
    const chatId = getCurrentChatId();
    if (!chatId) {
        window.toastr?.warning?.('没有打开的对话');
        return;
    }

    // 获取上下文
    const context = getContext();
    if (!context || !context.chat || !Array.isArray(context.chat)) {
        window.toastr?.warning?.('无法获取对话上下文');
        return;
    }

    // 收集所有消息 - 仅聊天记录
    const prompts = [];
    
    // 聊天历史
    for (let i = 0; i < context.chat.length; i++) {
        const message = context.chat[i];
        if (message.mes) {
            prompts.push({
                id: uuidv4(),
                text: message.mes,
                excluded: false,
                source: `${message.is_user ? '用户消息' : '角色回复'} (楼层 ${i})`
            });
        }
    }
    
    // 保存到设置
    extension_settings.tag_blocker.excludedPrompts = prompts;
    saveTagBlockerSettings();
    await loadPromptList();
    
    return prompts.length;
}

/**
 * 刷新Prompt列表
 */
async function refreshPrompts() {
    await loadPromptList();
    window.toastr?.success?.('刷新成功');
}

/**
 * 检查文本是否应用规则
 * @param {TagBlockerTag} tag 规则
 * @param {string} text 文本
 * @param {number|null} depth 楼层深度
 * @param {number} placement 应用位置类型
 * @returns {boolean} 是否应应用规则
 */
function shouldApplyRule(tag, text, depth, placement) {
    // 检查是否启用
    if (!tag.enabled) return false;
    
    // 检查应用位置
    if (!tag.placement.includes(placement)) return false;
    
    // 检查楼层限制
    if (depth !== null) {
        if (tag.minDepth !== null && depth < tag.minDepth) return false;
        if (tag.maxDepth !== null && depth > tag.maxDepth) return false;
    }
    
    // 检查是否在排除列表中
    const excludedPrompts = extension_settings.tag_blocker.excludedPrompts || [];
    for (const prompt of excludedPrompts) {
        if (prompt.excluded && text.includes(prompt.text)) {
            return false;
        }
    }
    
    return true;
}

/**
 * 应用标签屏蔽规则
 * @param {string} text 需要处理的文本
 * @param {number|null} depth 楼层深度
 * @param {number} placement 位置类型 (0=用户输入, 1=AI回复, 2=系统提示)
 * @returns {string} 处理后的文本
 */
function applyTagBlockRules(text, depth = null, placement = 2) {
    if (!extension_settings.tag_blocker || !Array.isArray(extension_settings.tag_blocker.tags)) {
        return text;
    }
    
    let result = text;
    let wasModified = false;
    
    logDebug(`处理文本 [深度=${depth}, 位置=${placement}]`);
    
    // 应用每个规则
    for (const tag of extension_settings.tag_blocker.tags) {
        if (!shouldApplyRule(tag, result, depth, placement)) {
            continue;
        }
        
        let processedText;
        
        // 根据规则类型处理文本
        if (tag.regexPattern) {
            // 使用正则表达式处理
            processedText = processWithRegex(result, tag.regexPattern, tag.replaceString);
        } else {
            // 使用标签处理
            processedText = processWithTags(result, tag.startTag, tag.endTag, tag.replaceString);
        }
        
        // 检查是否有变化
        if (processedText !== result) {
            logDebug(`规则 "${tag.scriptName}" 应用成功`);
            result = processedText;
            wasModified = true;
        }
    }
    
    if (wasModified) {
        logDebug('文本已被修改');
    }
    
    return result;
}

// 拦截prompt发送
function interceptPrompt(data) {
    // 不修改原始数据结构，只处理发送内容
    if (data.prompt) {
        // 保存原始prompt以便调试
        data._originalPrompt = data.prompt;
        // 应用标签屏蔽规则 - 系统提示
        data.prompt = applyTagBlockRules(data.prompt, null, 2);
    }
    return data;
}

// 声明一个全局变量来保存原始的fetch方法
let originalFetch;

// 只有在运行在浏览器环境中时才应用拦截器
if (typeof window !== 'undefined' && window.fetch) {
    originalFetch = window.fetch;
    window.fetch = function(resource, options) {
        // 只处理发送给AI的请求
        const resourceStr = resource.toString();
        // 支持更多可能的API端点
        if (resourceStr.includes("/api/v1/generate") ||
            resourceStr.includes("/api/v1/chat") ||
            resourceStr.includes("/v1/chat/completions") ||
            resourceStr.includes("/v1/completions") ||
            resourceStr.includes("/generate") ||
            resourceStr.includes("/chat/completions") ||
            resourceStr.includes("/completions") ||
            // Claude API
            resourceStr.includes("/v1/messages") ||
            // Gemini API
            resourceStr.includes("/v1beta/models") ||
            // 本地AI服务
            resourceStr.includes("localhost") && (
                resourceStr.includes("/generate") || 
                resourceStr.includes("/chat") || 
                resourceStr.includes("/completion")
            )) {
            
            if (options && options.body) {
                try {
                    // 处理不同的body类型
                    let body;
                    
                    if (typeof options.body === 'string') {
                        body = JSON.parse(options.body);
                    } else if (options.body instanceof FormData) {
                        logDebug("检测到FormData格式，暂不处理");
                        return originalFetch.call(window, resource, options);
                    } else if (options.body instanceof Blob || options.body instanceof ArrayBuffer) {
                        logDebug("检测到二进制数据，暂不处理");
                        return originalFetch.call(window, resource, options);
                    } else {
                        logDebug("未知的body类型", typeof options.body);
                        return originalFetch.call(window, resource, options);
                    }
                    
                    // 处理不同API格式的请求
                    
                    // 应用标签屏蔽规则 - OpenAI格式
                    if (body.prompt) {
                        body.prompt = applyTagBlockRules(body.prompt, null, 2);
                    }
                    
                    if (body.messages && Array.isArray(body.messages)) {
                        body.messages.forEach((msg, index) => {
                            if (msg.content) {
                                if (typeof msg.content === 'string') {
                                    // 用户消息或AI回复
                                    const placement = msg.role === 'user' ? 0 : (msg.role === 'assistant' ? 1 : 2);
                                    msg.content = applyTagBlockRules(msg.content, index, placement);
                                } else if (Array.isArray(msg.content)) {
                                    // 处理多模态内容
                                    msg.content.forEach(part => {
                                        if (part.type === 'text' && part.text) {
                                            // 用户消息或AI回复
                                            const placement = msg.role === 'user' ? 0 : (msg.role === 'assistant' ? 1 : 2);
                                            part.text = applyTagBlockRules(part.text, index, placement);
                                        }
                                    });
                                }
                            }
                        });
                    }
                    
                    // Kobold AI / TextGeneration WebUI 格式
                    if (body.text) {
                        body.text = applyTagBlockRules(body.text, null, 2);
                    }
                    
                    // NovelAI格式
                    if (body.input) {
                        body.input = applyTagBlockRules(body.input, null, 2);
                    }
                    
                    // 处理Anthropic/Claude格式
                    if (body.text) {
                        body.text = applyTagBlockRules(body.text, null, 2);
                    }
                    if (body.content) {
                        if (typeof body.content === 'string') {
                            body.content = applyTagBlockRules(body.content, null, 0); // 假设是用户输入
                        } else if (Array.isArray(body.content)) {
                            body.content.forEach(item => {
                                if (item.type === 'text' && item.text) {
                                    item.text = applyTagBlockRules(item.text, null, 0);
                                }
                            });
                        }
                    }
                    
                    // 重新序列化
                    options.body = JSON.stringify(body);
                } catch (error) {
                    console.error("内容处理器处理请求时出错:", error);
                }
            }
        }
        
        // 调用原始fetch函数
        return originalFetch.call(window, resource, options);
    };
}

// 初始化扩展
jQuery(async () => {
    if (extension_settings.disabledExtensions.includes('tag-blocker')) {
        return;
    }

    // 创建HTML在页面上
    $('#extensions_settings').append(await renderExtensionTemplateAsync('tag-blocker', 'dropdown'));

    // 自动刷新开关
    const autoRefreshToggle = $('#auto-refresh-toggle');
    autoRefreshToggle.prop('checked', extension_settings.tag_blocker.autoRefresh !== false);
    
    autoRefreshToggle.on('change', function() {
        extension_settings.tag_blocker.autoRefresh = $(this).prop('checked');
        saveTagBlockerSettings();
    });
    
    // 调试模式开关
    const debugModeToggle = $('#debug-mode-toggle');
    debugModeToggle.prop('checked', extension_settings.tag_blocker.debugMode === true);
    
    debugModeToggle.on('change', function() {
        extension_settings.tag_blocker.debugMode = $(this).prop('checked');
        saveTagBlockerSettings();
    });

    // 注册事件处理程序
    $('#add-tag-button').on('click', onAddTagClick);
    $('#add-regex-button').on('click', onAddRegexClick);
    $('#import-script-button').on('click', onImportScriptClick);
    $('#export-rules-button').on('click', onExportRulesClick);
    
    $('#scan-prompts-button').on('click', async function() {
        const count = await scanPrompts();
        window.toastr?.success?.('成功扫描对话，找到 ' + count + ' 条消息');
    });
    
    $('#refresh-prompts-button').on('click', async function() {
        await refreshPrompts();
        window.toastr?.success?.('刷新成功');
    });
    
    // 批量排除/包含
    $('#exclude-all-button').on('click', function() {
        if (!extension_settings.tag_blocker.excludedPrompts || extension_settings.tag_blocker.excludedPrompts.length === 0) {
            window.toastr?.warning?.('没有可排除的Prompt，请先扫描对话');
            return;
        }
        
        extension_settings.tag_blocker.excludedPrompts.forEach(prompt => {
            prompt.excluded = true;
        });
        
        saveTagBlockerSettings();
        loadPromptList();
        window.toastr?.success?.('已排除所有Prompt');
    });
    
    $('#include-all-button').on('click', function() {
        if (!extension_settings.tag_blocker.excludedPrompts || extension_settings.tag_blocker.excludedPrompts.length === 0) {
            window.toastr?.warning?.('没有可包含的Prompt，请先扫描对话');
            return;
        }
        
        extension_settings.tag_blocker.excludedPrompts.forEach(prompt => {
            prompt.excluded = false;
        });
        
        saveTagBlockerSettings();
        loadPromptList();
        window.toastr?.success?.('已包含所有Prompt');
    });
    
    // 搜索功能
    $('#prompt-search').on('input', function() {
        const searchTerm = $(this).val().toLowerCase();
        filterPrompts(searchTerm);
    });
    
    // 过滤功能
    let activeFilter = 'all';
    
    $('#prompt-filter-all').on('click', function() {
        activeFilter = 'all';
        $('.menu_button.active-filter').removeClass('active-filter');
        $(this).addClass('active-filter');
        const searchTerm = $('#prompt-search').val().toLowerCase();
        filterPrompts(searchTerm);
    });
    
    $('#prompt-filter-excluded').on('click', function() {
        activeFilter = 'excluded';
        $('.menu_button.active-filter').removeClass('active-filter');
        $(this).addClass('active-filter');
        const searchTerm = $('#prompt-search').val().toLowerCase();
        filterPrompts(searchTerm);
    });
    
    $('#prompt-filter-included').on('click', function() {
        activeFilter = 'included';
        $('.menu_button.active-filter').removeClass('active-filter');
        $(this).addClass('active-filter');
        const searchTerm = $('#prompt-search').val().toLowerCase();
        filterPrompts(searchTerm);
    });
    
    // 过滤Prompt的函数
    function filterPrompts(searchTerm) {
        $('.prompt-item').each(function() {
            const $this = $(this);
            const text = $this.find('.prompt-text').text().toLowerCase();
            const source = $this.find('.prompt-source').text().toLowerCase();
            const isExcluded = $this.hasClass('excluded');
            
            // 先根据搜索词过滤
            const matchesSearch = searchTerm === '' || 
                                text.includes(searchTerm) || 
                                source.includes(searchTerm);
            
            // 再根据状态过滤
            const matchesFilter = activeFilter === 'all' || 
                                (activeFilter === 'excluded' && isExcluded) || 
                                (activeFilter === 'included' && !isExcluded);
            
            if (matchesSearch && matchesFilter) {
                $this.removeClass('filtered');
            } else {
                $this.addClass('filtered');
            }
        });
        
        // 检查是否有可见的项目
        if ($('.prompt-item:not(.filtered)').length === 0) {
            if ($('.prompt-item').length > 0) {
                if (!$('#no-results-message').length) {
                    $('#prompt-list').append('<div id="no-results-message" class="flex-container justifyCenter">没有匹配的结果</div>');
                }
            }
        } else {
            $('#no-results-message').remove();
        }
    }

    // 尝试导入示例脚本
    try {
        const lyeanScript = extension_settings.tag_blocker.tags.find(t => 
            t.scriptName === "【Lyean】[不发送]5楼以上除摘要外文本");
            
        if (!lyeanScript) {
            const defaultScript = {
                id: "bb776c36-7af4-40dd-9ede-b9ececfcb184",
                scriptName: "【Lyean】[不发送]5楼以上除摘要外文本",
                findRegex: "/([\\s\\S]*?<details><summary>摘要</summary>|</details>[\\s\\S]*?$)/gs",
                replaceString: "",
                trimStrings: [],
                placement: [2],
                disabled: false,
                markdownOnly: false,
                promptOnly: true,
                runOnEdit: true,
                substituteRegex: 0,
                minDepth: 5,
                maxDepth: null
            };
            
            const newTag = importScriptToTag(defaultScript);
            extension_settings.tag_blocker.tags.push(newTag);
            saveTagBlockerSettings();
        }
    } catch (error) {
        console.error("导入示例脚本失败:", error);
    }

    // 加载标签和排除的Prompt
    await loadTagList();
    
    // 初始自动扫描，使用延迟确保其他组件已加载
    setTimeout(() => {
        scanPrompts().then(() => {
            loadPromptList();
        });
    }, 1000);

    // 注册事件监听器
    eventSource.on(event_types.GENERATE_QUEUED, interceptPrompt);
    
    // 自动刷新事件处理器
    let debounceTimer = null;
    
    function autoScanIfEnabled() {
        if (extension_settings.tag_blocker.autoRefresh !== false) {
            // 使用防抖，避免频繁触发
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            
            debounceTimer = setTimeout(() => {
                scanPrompts().then(() => {
                    loadPromptList();
                });
                debounceTimer = null;
            }, 500);
        }
    }
    
    // 监听聊天变更事件 - 当打开一个新的角色卡时自动扫描
    eventSource.on(event_types.CHAT_CHANGED, autoScanIfEnabled);
    
    // 监听AI回复结束事件 - 每次AI回复后自动扫描
    eventSource.on(event_types.MESSAGE_RECEIVED, autoScanIfEnabled);
    
    // 也监听用户消息发送事件 - 每次用户发送消息后自动扫描
    eventSource.on(event_types.MESSAGE_SENT, autoScanIfEnabled);

    console.log("高级内容处理器扩展已加载");
}); 