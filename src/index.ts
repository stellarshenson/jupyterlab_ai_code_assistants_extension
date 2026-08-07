import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { requestAPI } from './request';

/**
 * Initialization data for the jupyterlab_ai_code_assistants_extension extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_ai_code_assistants_extension:plugin',
  description: 'Jupyterlab extension to replace individual jupyterlab_*_code_extension and integrate into one, that offers joint capability, joint settings page and individual right toolbar panels per code assistant, with the ability in settings to decide which code assistant support is on (default - all are enabled)',
  autoStart: true,
  optional: [ISettingRegistry],
  activate: (app: JupyterFrontEnd, settingRegistry: ISettingRegistry | null) => {
    console.log('JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!');

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          console.log('jupyterlab_ai_code_assistants_extension settings loaded:', settings.composite);
        })
        .catch(reason => {
          console.error('Failed to load settings for jupyterlab_ai_code_assistants_extension.', reason);
        });
    }

    requestAPI<any>('hello', app.serviceManager.serverSettings)
      .then(data => {
        console.log(data);
      })
      .catch(reason => {
        console.error(
          `The jupyterlab_ai_code_assistants_extension server extension appears to be missing.\n${reason}`
        );
      });
  }
};

export default plugin;
