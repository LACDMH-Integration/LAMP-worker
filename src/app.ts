require("dotenv").config()
import express, { Application, Router, Request, Response } from "express"
import { connect, NatsConnectionOptions, Payload, Client } from "ts-nats"
import _Docker from "dockerode"
import { NotificationScheduling, cleanAllQueues, UpdateSchedule } from "./queue/ActivitySchedulerJob"
import { StoreAutomations, TriggerAutomations, LocateAutomation } from "./queue/Automation"
import { initializeQueues } from "./queue/Queue"
import LAMP from "lamp-core"
import ioredis from "ioredis"
let RedisClient: ioredis.Redis
let nc: Client
const app: Application = express()
const _server = app

//LAMP-worker nats listeners
const topics = [
  "activity_event",
  "lamp.automation",
  "activity",
  "participant",
  "researcher",
  "sensor_event",
  "sensor",
  "study",
]
process.on("unhandledRejection", (error) => {
  console.dir(error)
})

//LAMP-worker triggers for automation script
export let triggers = {
  "researcher.*": new Array(),
  "researcher.*.study.*": new Array(),
  "study.*.participant.*": new Array(),
  "study.*.activity.*": new Array(),
  "study.*.sensor.*": new Array(),
  "activity.*.participant.*": new Array(),
  "sensor.*.participant.*": new Array(),
} as any

/**Initialize and configure the application.
 *
 */
async function main(): Promise<void> {
  try {
    if (typeof process.env.REDIS_HOST === "string") {
      let intervalId = setInterval(async () => {
        try {
          new Promise((resolve, reject) => {
            RedisClient = new ioredis(         
              parseInt(`${(process.env.REDIS_HOST as any).match(/([0-9]+)/g)?.[0]}`),
              (process.env.REDIS_HOST as any).match(/\/\/([0-9a-zA-Z._]+)/g)?.[0]
            )
            console.log("Trying to connect redis")
            RedisClient.on("connect", async() => {
              console.log("Connected to redis")
              await initializeQueues()
              if (process.env.SCHEDULER === "on") {
                console.log("Clean all queues...")
                await cleanAllQueues()
                console.log("Initializing schedulers...")
                NotificationScheduling()
              } else {
                console.log("Running with schedulers disabled.")
              }
              clearInterval(intervalId)
              resolve
            })
            RedisClient.on("error", async () => {
              console.log("redis connection error")              
              reject()
            })
            RedisClient.on("disconnected", async () => {
              console.log(" redis disconnected")
              reject()
            })
          })
        } catch (err) {
          console.log("Error initializing redis ", err)
        }
      }, 10000)
    }
    await ServerConnect()
    await NatsConnect()    
    
    //Starting the server
    _server.listen(process.env.PORT || 3000)
    console.log(`server listening in ${process.env.PORT}`)
  } catch (error) {
    console.log("Encountered issue while starting LAMP-worker", error)
  }
  if (!!process.env.AUTOMATION && process.env.AUTOMATION === "on") {
    console.log("Locating automations...")
    const researchers = (await LAMP.Researcher.all()) as any
    for (let researcher of researchers) {
      try {
        LocateAutomation(researcher.id)
      } catch (error) {
        console.log("Encountered issue Locating automation", error)
      }
    }
  } else {
    console.log("Running with automation disabled.")
  }
}

/**
 * nats connect
 */
async function NatsConnect() {
  let intervalId = setInterval(async () => {
    try {
      nc = await connect({
        servers: [`${process.env.NATS_SERVER}`],
        payload: Payload.JSON,
        maxReconnectAttempts: -1,
        reconnect: true,
        reconnectTimeWait: 2000,
      })
      clearInterval(intervalId)
      console.log("Connected to nats sub server")
      SubscribeTopics()
    } catch (error) {
      console.log("Error in Connecting to nats sub server")
    }
  }, 10000)
}

/**
 * subscribe topics from nats server
 */
async function SubscribeTopics() {
  topics.map((topic: any) => {
    nc.subscribe(topic, async (err, msg) => {
      const data = msg.data
      //update schedule if needed
      UpdateSchedule(topic, data.data)
      if (!!process.env.AUTOMATION && process.env.AUTOMATION === "on") {
        //store automations if needed
        StoreAutomations(topic, data.data)
        //invoke automation script if needed
        TriggerAutomations(data.token, data.data)
      }
    })
  })
}
/**
 * Initializing LAMP_SERVER connection
 */
async function ServerConnect(): Promise<void> {
  try {
    const server_url = `${process.env.LAMP_SERVER}`
    const accessKey = process.env.LAMP_AUTH?.split(":")[0] as string
    const secretKey = process.env.LAMP_AUTH?.split(":")[1] as string
    await LAMP.connect({ accessKey: accessKey, secretKey: secretKey, serverAddress: server_url })
  } catch (error) {
    console.log("Lamp server connect error", error)
    throw new error("Lamp server connection failed ")
  }
}

main().catch(console.error)
