import { expect, test } from 'claude-code/testing'

const PROPS = { title: 'Workbench', isFocused: false, bodyColumns: 101, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

test('inside the workbench the deck fills its own slot and leaves the rest of the frame', async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: 'workbench' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Box key="slot-usage-tracker" width={50}><Text>usage placeholder</Text></Box>
        <Box key="slot-agent-deck" width={50}><Text>deck placeholder</Text></Box>
      </Box>
    )
  })
  const ui = await $.ui.mount({ plugin: 'agent-deck', surface: 'terminal', component: 'Pane', requestId: 'workbench', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /AGENTS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /deck placeholder/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /usage placeholder/ })).toBeDefined()
})
