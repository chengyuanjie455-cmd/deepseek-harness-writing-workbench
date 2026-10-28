// @deepseek-ai/dsh-client-ui-tool 0.1.5-rc.2, extracted from the installed client.
function ToolCallTree({ renderSlot, node, cwd, openFile, inspectCall, loadImage, useHostInfo, t }) {
			const home = useHostInfo((info) => info.home);
			const block = node.data.root;
			return (0, react_jsx_runtime.jsx)(ToolCallBranch, {
				renderSlot,
				block,
				cwd,
				home,
				openFile,
				inspectCall,
				loadImage,
				t
			});
		}
