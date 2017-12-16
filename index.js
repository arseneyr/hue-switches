const inquirer = require("inquirer");
const { writeFileSync } = require("fs");
const Rx = require("rx-lite");
const clear = require("clear");
const rp = require("request-promise");
const Spinner = require("clui").Spinner;

const API_KEY = "vPrv0yLLuI4tfeJh10RGmZ8bzOR53-4g1DuaImow";
let url;

async function clear_rules(rules) {
  for (const rule of Object.keys(rules)) {
    await rp.delete(`${url}/rules/${rule}`);
  }
}

async function apply(switches, rooms, lights) {
  const scene_mappings = [
    {
      button_id: "34",
      name: "default",
      action: { on: true, bri: 217, xy: [0.4449, 0.4066], transitiontime: 2 }
    },
    {
      button_id: "16",
      name: "relax",
      action: { on: true, bri: 144, xy: [0.5134, 0.4149], transitiontime: 2 }
    },
    {
      button_id: "17",
      name: "energize",
      action: { on: true, bri: 219, xy: [0.3693, 0.3695], transitiontime: 2 }
    },
    {
      button_id: "18",
      name: "mood",
      action: { on: true, bri: 3, xy: [0.5134, 0.4149], transitiontime: 2 }
    }
  ];

  const new_rules = Object.values(switches)
    .filter(s => s.room && rooms[s.room])
    .reduce((curr_array, curr_switch) => {
      const new_rule = scene_mappings.map(scene => ({
        name: `${curr_switch.name} - ${scene.name}`,
        conditions: [
          {
            address: `/sensors/${curr_switch.id}/state/buttonevent`,
            operator: "eq",
            value: scene.button_id
          }
        ],
        actions: rooms[curr_switch.room].lights.map(l => ({
          address: `/lights/${l}/state`,
          method: "PUT",
          body: scene.action
        }))
      }));

      // Main button only turns on if none of the lights in the room are on
      new_rule.find(e => e.conditions[0].value === "34").conditions.push(
        {
          address: `/sensors/${curr_switch.id}/state/lastupdated`,
          operator: "dx"
        },
        {
          address: `/groups/${curr_switch.room}/state/any_on`,
          operator: "eq",
          value: "false "
        }
      );

      // Include OFF rule if main button is pressed and any of the lights
      // in the room are off
      return curr_array.concat(new_rule, {
        name: `${curr_switch.name} - OFF`,
        conditions: [
          {
            address: `/sensors/${curr_switch.id}/state/buttonevent`,
            operator: "eq",
            value: "34"
          },
          {
            address: `/sensors/${curr_switch.id}/state/lastupdated`,
            operator: "dx"
          },
          {
            address: `/groups/${curr_switch.room}/state/any_on`,
            operator: "eq",
            value: "true"
          }
        ],
        actions: rooms[curr_switch.room].lights.map(l => ({
          address: `/lights/${l}/state`,
          method: "PUT",
          body: {
            on: false,
            transitiontime: 3
          }
        }))
      });
    }, []);

  for (const r of new_rules) {
    await rp.post({ url: `${url}/rules/`, json: true, body: r });
  }
}

async function run() {
  let raw_data;
  const spinner = new Spinner("Fetching details from hue bridge...");
  clear();
  spinner.start();
  const body = await rp({
    url: "https://www.meethue.com/api/nupnp",
    json: true
  });
  for (const bridge of body) {
    url = `http://${bridge.internalipaddress}/api/${API_KEY}`;
    let result = await rp({
      url,
      json: true
    });
    if (result.config) {
      raw_data = result;
      break;
    }
  }

  if (!raw_data) {
    console.log("No bridges found!");
    return;
  }
  spinner.stop();

  const rules = Object.entries(raw_data.rules)
    .filter(([_, { owner }]) => owner === API_KEY)
    .reduce((obj, [id, rule]) => {
      let sensor_result, group_result;
      if (
        rule.conditions.find(
          c => (sensor_result = /\/sensors\/(\d+?)\//.exec(c.address))
        ) &&
        rule.conditions.find(
          c => (group_result = /\/groups\/(\d+?)\//.exec(c.address))
        )
      ) {
        obj[id] = { id, trigger: sensor_result[1], room: group_result[1] };
      }
      return obj;
    }, {});

  const switches = Object.entries(raw_data.sensors)
    .filter(sensor => sensor[1].type === "ZGPSwitch")
    .reduce((obj, [id, sensor]) => {
      const rule = Object.values(rules).find(r => r.trigger === id);
      obj[id] = {
        id,
        name: sensor.name,
        room: rule && rule.room
      };
      return obj;
    }, {});

  const rooms = Object.entries(raw_data.groups)
    .filter(group => group[1].type === "Room")
    .reduce((obj, group) => {
      obj[group[0]] = {
        id: group[0],
        name: group[1].name,
        lights: group[1].lights
      };
      return obj;
    }, {});

  const lights = Object.entries(raw_data.lights).reduce((obj, light) => {
    obj[light[0]] = { id: light[0], name: light[1].name };
    return obj;
  }, {});

  const main_prompt = () => ({
    type: "list",
    name: "main",
    message: "Choose a switch to modify (current room)",
    default: ({ main }) => main,
    pageSize: 20,
    choices: Object.values(switches)
      .map(s => ({
        name: `${s.name} (${(s.room && rooms[s.room] && rooms[s.room].name) ||
          ""})`,
        value: s.id
      }))
      .concat([new inquirer.Separator(), "Apply", "Debug Dump", "Exit"])
  });

  let answers;

  while (1) {
    clear();

    answers = await inquirer.prompt(main_prompt());
    if (answers.main === "Apply" || answers.main === "Exit") {
      break;
    }

    clear();

    if (answers.main === "Debug Dump") {
      answers = await inquirer.prompt({
        type: "input",
        name: "dump",
        default: "dump.json",
        message: "Choose a filename for the dump:"
      });
      writeFileSync(answers.dump, JSON.stringify(raw_data, null, 4));
      continue;
    }

    const chosen_switch = switches[answers.main];

    answers = await inquirer.prompt({
      type: "list",
      name: "room",
      message: `Choose a room for the ${chosen_switch.name} switch`,
      pageSize: 30,
      choices: Object.values(rooms)
        .map(room => ({ name: room.name, value: room.id }))
        .concat("<None>", new inquirer.Separator(), "Back")
    });

    if (answers.room === "<None>") {
      delete chosen_switch.room;
    } else if (answers.room !== "Back") {
      chosen_switch.room = answers.room;
    }
  }

  if (answers.main === "Apply") {
    clear();
    spinner.message("Deleting existing rules...");
    spinner.start();
    await clear_rules(rules);
    spinner.message("Applying new rules...");
    await apply(switches, rooms, lights);
    spinner.stop();
  }
}

run();
