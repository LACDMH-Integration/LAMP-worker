import {
  SchedulerQueue,
  SchedulerReferenceQueue,
  SchedulerDeviceUpdateQueue,
  UpdateToSchedulerQueue,
  DeleteFromSchedulerQueue,
} from "./Queue"
import { Mutex } from "async-mutex"
import LAMP from "lamp-core"
import { LocateAutomation } from "./Automation"

const clientLock = new Mutex()
/// List activities for a given ID; if a Participant ID is not provided, undefined = list ALL.
export const ActivityScheduler = async (id?: string, studyID?: string, items?: any[]): Promise<void> => {
  console.log("Preparing to fetch activities")
  let activities: any[] = []
  if (!!items) {
    activities = items
  } else {
    activities = [(await LAMP.Activity.view(id as any, undefined, true)) as any]
  }
  console.log("activity_id given", id)
  console.log("Saving to redis")
  console.log(`Processing ${activities.length} activities for push notifications.`)
  const release = await clientLock.acquire()
  console.log(`locked job on activity_scheduler`)
  // Process activities to find schedules and corresponding participants.
  for (const activity of activities) {
    try {
      if (undefined !== activity.id) {
        //remove all jobs created for the an activity from queue
        await removeActivityJobs(activity.id)
      }
      // If the activity has no schedules, ignore it.
      if (activity.schedule.length === 0) continue
      // Get all the participants of the study that the activity belongs to.
      let study: any = ""
      let participants: any = ""
      let parent: any = ""
      try {
        if (!!studyID) {
          study = studyID
        } else {
          parent = await LAMP.Type.parent(activity.id)
          study = parent?.data.Study
        }
      } catch (error) {
        console.log("Error fetching Study", error)
        continue
      }
      try {
        const particpantDetails = await LAMP.Participant.allByStudy(study)
        participants = particpantDetails
      } catch (error) {
        console.log("Error fetching participants by study")
        continue
      }
      if (participants.length === 0) continue
      const Participants: any[] = []
      for (const participant of participants) {
        try {
          const event_data = await LAMP.SensorEvent.allByParticipant(
            participant.id,
            "lamp.analytics",
            undefined,
            undefined,
            1000
          )
          if (event_data.length === 0) continue
          const filteredArray: any = await event_data.filter(
            (x: any) =>
              x.data.type === undefined 
              && (x.data.action === "login" || x.data.action === "logout")
              && x.data.device_type !== "Dashboard"
          )
          if (filteredArray.length === 0) continue
          const events: any = filteredArray[0]
          const device = undefined !== events && undefined !== events.data ? events.data : undefined
          if (device === undefined || device.device_token === undefined) continue
          //take Device_Tokens and ParticipantIDs
          if (participant.id && device.device_token && device.device_type) {
            Participants.unshift({
              participant_id: participant.id,
              device_token: device.device_token,
              device_type: device.device_type.toLowerCase(),
            })
          }
        } catch (error) {
          console.log(`"Error fetching Participant Device-${error}"`)
        }
      }
      // Iterate all schedules, and if the schedule should be fired at this instant, iterate all participants
      // and their potential device tokens for which we will send the device push notifications.
      if (Participants.length !== 0) {
        for (const schedule of activity.schedule) {
          if (schedule.time === "1970-01-01T12:48:00.000Z" || schedule.start_date === "1970-01-01T12:48:00.000Z")
            continue
          const cronStr = schedule.repeat_interval !== "none" ? await getCronScheduleString(schedule) : ""
          let startDateExploded = schedule.start_date ? schedule.start_date.split("T") : undefined
          let TimeExploded = schedule.time ? schedule.time.split("T") : undefined
          let timHr = TimeExploded[1].split(":")[0]
          let timMt = TimeExploded[1].split(":")[1]
          let start_date = `${startDateExploded[0]}T${timHr}:${timMt}:00.000Z`
          console.log("start_date========", start_date)
          if (schedule.repeat_interval !== "custom") {
            const notification_id = !!schedule.notification_ids ? schedule.notification_ids[0] : undefined
            const scheduler_payload: any = {
              title: activity.name,
              start_date: schedule.repeat_interval === "none" ? undefined : start_date,
              message: `You have a mindLAMP activity waiting for you: ${activity.name}.`,
              activity_id: activity.id,
              participants: await removeDuplicateParticipants(Participants),
              notificationIds: notification_id,
            }

            let SchedulerjobResponse: any = ""
            try {
              if (schedule.repeat_interval !== "none") {
                //repeatable job - daily,biweekly,hourly,monthly etc
                SchedulerjobResponse = await SchedulerQueue?.add(scheduler_payload, {
                  removeOnComplete: true,
                  removeOnFail: true,
                  backoff: 10000,
                  attempts: 2,
                  repeat: { jobId: activity.id, cron: cronStr },
                })
                if (schedule.repeat_interval === "fortnightly")
                  await setFortnightlySchedule(scheduler_payload, activity.id)
              } else {
                if (new Date(start_date) > new Date()) {
                  //non repeatable job --none
                  SchedulerjobResponse = await SchedulerQueue?.add(scheduler_payload, {
                    removeOnComplete: true,
                    removeOnFail: true,
                    backoff: 10000,
                    attempts: 2,
                    jobId: `${activity.id}|none|${new Date(start_date).getTime()}`,
                    delay: Math.floor(new Date(start_date).getTime() - new Date().getTime()),
                  })
                }
              }
            } catch (error) {
              console.log("error while adding to scheduler queue---", error)
            }
            // updating ShedulerReference Queue(if already activity_id exists as JobId)
            const SchedulerReferenceJob = (await SchedulerReferenceQueue?.getJob(activity.id)) || null
            if (null !== SchedulerReferenceJob) {
              if (!!SchedulerjobResponse.id) {
                const SchedulerReferenceIds: any = SchedulerReferenceJob?.data.scheduler_ref_ids || []
                const existSchedulerId = await SchedulerReferenceIds.filter((referenceId: any) =>
                  referenceId.includes(SchedulerjobResponse.id)
                )
                if (existSchedulerId.length === 0 && undefined === existSchedulerId[0]) {
                  await SchedulerReferenceIds.push(SchedulerjobResponse.id)
                  await SchedulerReferenceJob?.update({
                    scheduler_ref_ids: SchedulerReferenceIds,
                    activity_id: activity.id,
                  })
                }
              }
            } else {
              //add to scheduler reference queue(as we cannot make custom id for repeatable job, we need a reference of schedular jobids)
              if (SchedulerjobResponse.id != undefined) {
                await SchedulerReferenceQueue?.add(
                  { scheduler_ref_ids: [SchedulerjobResponse.id], activity_id: activity.id },
                  { jobId: activity.id }
                )
              }
            }
          } else {
            const notification_id = !!schedule.notification_ids ? schedule.notification_ids : undefined
            //As the custom time might appear as multiple, process it seperately
            const activity_details: {} = {
              name: activity.name,
              activity_id: activity.id,
              cronStr: cronStr,
              notificationIds: notification_id,
              start_date: start_date,
            }
            await setCustomSchedule(activity_details, Participants)
          }
        }
      } else {
        continue
      }
    } catch (error) {
      console.log("Encountered an error in handling the queue job")
    }
  }
  console.log("Saving to Redis completed....")
  release()
  console.log(`release lock  on success  activity_scheduler`)
}

/**store schedules for valid study based activities
 *
 */
export const fetchLampData = async (): Promise<void> => {
  if (!!process.env.REDIS_HOST && !!SchedulerQueue) {    
    //fetch all researchers
    let intervalId = setInterval(async () => {
      let researchers: any[] = []
      console.log("Fetching Researchers")
      try {
        researchers = await LAMP.Researcher.all()
        clearInterval(intervalId)        
      } catch (err) {
        throw err
      }
      for (let researcher of researchers) {
        let studies: any[] = []
        try {
          //fetch researcher based studies
          studies = await LAMP.Study.allByResearcher(researcher.id as string)
          if (!!process.env.AUTOMATION && process.env.AUTOMATION === "on") {
            try {
              LocateAutomation(researcher.id)
            } catch (error) {
              console.log("Encountered issue Locating automation", error)
            }
          }
        } catch (error) {
          console.log("error while fetching researcher---", error)
        }
        for (let study of studies) {
          let activities: any[] = []
          try {
            activities = await LAMP.Activity.allByStudy(study.id as string, undefined, true)
          } catch (error) {
            console.log("error while fetching activities---", error)
          }
          for (let activity of activities) {
            try {
              //set scheduler for each activity which contain valid schedules
              if (activity.schedule === undefined || activity?.schedule?.length === 0) continue
              await ActivityScheduler(activity.id, study.id, [activity] as any)
            } catch (error) {
              console.log("error while schedule start---", error)
            }
          }
        }
      }
      console.log("scheduling completed")
    }, 10000)
  }
}

/**get the cron string
 *
 * @param array schedule
 * @returns string cronStr
 */
function getCronScheduleString(schedule: any): string {
  let cronStr = ""
  //feed date time
  const feedDateTime = new Date(schedule.time)
  const feedStartDateTime = new Date(schedule.start_date)
  const followingDay = new Date(new Date(schedule.time).getTime() + 86400000) // + 1 day in ms
  let feedUTCNewHours = ""
  //get hour,minute,second formatted time from feed date time
  let feedHoursUtc: any = feedDateTime.getUTCHours()
  let feedMinutesUtc: any = feedDateTime.getUTCMinutes()
  const sheduleDayNumber: number = new Date(feedStartDateTime).getUTCDay()
  const sheduleMonthDate: number = new Date(feedStartDateTime).getUTCDate()
  //prepare cronstring for various schedules
  switch (schedule.repeat_interval) {
    case "triweekly":
      cronStr = `${feedMinutesUtc} ${feedHoursUtc} * * 1,3,5`

      break
    case "biweekly":
      cronStr = `${feedMinutesUtc} ${feedHoursUtc} * * 2,4`
      break
    case "weekly":
      cronStr = `${feedMinutesUtc} ${feedHoursUtc} * * ${sheduleDayNumber}`
      break
    case "daily":
      cronStr = `${feedMinutesUtc} ${feedHoursUtc} * * *`
      break
    case "custom":
      schedule.custom_time.map((time: any) => {
        //get hour,minute,second from each of the custom time array
        let customHoursUtc: any = new Date(time).getUTCHours()
        let customMinutesUtc: any = new Date(time).getUTCMinutes()
        //set the multiple cron string  with identifier '|'
        cronStr += `${customMinutesUtc} ${customHoursUtc} * * *|`
      })
      break
    case "hourly":
      cronStr = `${feedMinutesUtc} */1 * * *`
      break
    case "every3h":
      followingDay.toLocaleDateString()
      while (feedDateTime < followingDay) {
        feedDateTime.setUTCHours(feedDateTime.getUTCHours() + 3)
        feedUTCNewHours +=
          feedDateTime < followingDay ? `${feedDateTime.getUTCHours()},` : `${feedDateTime.getUTCHours()}`

        cronStr = `${feedMinutesUtc} ${feedUTCNewHours} * * *`
      }
      break
    case "every6h":
      followingDay.toLocaleDateString()
      while (feedDateTime < followingDay) {
        feedDateTime.setUTCHours(feedDateTime.getUTCHours() + 6)
        feedUTCNewHours +=
          feedDateTime < followingDay ? `${feedDateTime.getUTCHours()},` : `${feedDateTime.getUTCHours()}`

        cronStr = `${feedMinutesUtc} ${feedUTCNewHours} * * *`
      }
      break
    case "every12h":
      followingDay.toLocaleDateString()
      while (feedDateTime < followingDay) {
        feedDateTime.setUTCHours(feedDateTime.getUTCHours() + 12)
        feedUTCNewHours +=
          feedDateTime < followingDay ? `${feedDateTime.getUTCHours()},` : `${feedDateTime.getUTCHours()}`
        cronStr = `${feedMinutesUtc} ${feedUTCNewHours} * * *`
      }
      break
    case "monthly":
      cronStr = `${feedMinutesUtc} ${feedHoursUtc} ${sheduleMonthDate} * *`
      break
    case "bimonthly":
      cronStr = `${feedMinutesUtc} ${feedHoursUtc} 10,20 * *`
      break
    case "fortnightly":
      console.log("fortnightly schedule")
      let startDateExploded = schedule.start_date ? schedule.start_date.split("T") : undefined
      let TimeExploded = schedule.time ? schedule.time.split("T") : undefined
      let timHr_ = TimeExploded[1].split(":")[0]
      let timMt_ = TimeExploded[1].split(":")[1]
      let start_date = `${startDateExploded[0]}T${timHr_}:${timMt_}:00.000Z`
      let next_ = new Date(start_date)
      next_.setDate(next_.getDate() + 14)
      let now = new Date()
      let timHr: number | string = now.getUTCHours()
      let timMt: number | string = now.getUTCMinutes()
      let dtMnt: number | string = now.getUTCMonth() + 1
      let dtDate: number | string = now.getUTCDate()
      timHr = timHr < 10 ? `0${timHr}` : timHr
      timMt = timMt < 10 ? `0${timMt}` : timMt
      dtMnt = dtMnt < 10 ? `0${dtMnt}` : dtMnt
      dtDate = dtDate < 10 ? `0${dtDate}` : dtDate
      console.log("timHr", timHr)
      console.log("timMt", timMt)
      console.log("dtMnt", dtMnt)
      console.log("dtDate", dtDate)
      let date_now = `${now.getUTCFullYear()}-${dtMnt}-${dtDate}T${timHr}:${timMt}:00.000Z`
      console.log("now", date_now)
      console.log("start_date", start_date)
      // let new_date = new Date(feedStartDateTime.setDate(feedStartDateTime.getDate() + 14));
      if (new Date(date_now) > new Date(start_date)) {
        console.log("now is greater than start date")
        next_ = new Date(`${now.getUTCFullYear()}-${dtMnt}-${dtDate}T${timHr_}:${timMt_}:00.000Z`)
        next_.setDate(next_.getDate() + 14)
      }
      console.log("new_date///", next_)
      let newsheduleDay = next_.getUTCDate()
      console.log("newsheduleDay", newsheduleDay)
      cronStr = `${timMt_} ${timHr_} ${newsheduleDay} * *`
      console.log("cronStr", cronStr)
      break
    default:
      break
  }
  return cronStr
}

/**set custom schedule
 *
 * @param activity
 * @param Participants
 */
async function setCustomSchedule(activity: any, Participants: string[]): Promise<any> {
  //split and get individual cron string
  let cronArr = activity.cronStr.split("|")
  const notificationIds = activity.notificationIds
  let count = 0

  for (const cronCustomString of cronArr) {
    if (undefined !== cronCustomString && "" !== cronCustomString) {
      //custom schedules may occur in multiple times and also need to run daily.
      if (activity.activity_id) {
        const notification_id = !!notificationIds[count] ? notificationIds[count] : undefined
        const scheduler_payload: any = {
          title: activity.name,
          start_date: activity.start_date ?? undefined,
          message: `You have a mindLAMP activity waiting for you: ${activity.name}.`,
          activity_id: activity.activity_id,
          participants: await removeDuplicateParticipants(Participants),
          notificationIds: notification_id,
        }
        //add to schedular queue
        try {
          const SchedulerjobResponse: any = await SchedulerQueue?.add(scheduler_payload, {
            removeOnComplete: true,
            removeOnFail: true,
            backoff: 10000,
            attempts: 2,
            repeat: { jobId: activity.activity_id, cron: cronCustomString },
          })
          const SchedulerReferenceJob = (await SchedulerReferenceQueue?.getJob(activity.activity_id)) || null

          //updating ShedulerReference Queue, if the activity is not saved (make activity.id as job id)
          if (null !== SchedulerReferenceJob) {
            if (!!SchedulerjobResponse.id) {
              const SchedulerReferenceIds: any = SchedulerReferenceJob?.data.scheduler_ref_ids
              const existSchedulerId = await SchedulerReferenceIds.filter((referenceId: any) =>
                referenceId.includes(SchedulerjobResponse?.id)
              )

              if (existSchedulerId.length === 0 && undefined === existSchedulerId[0]) {
                await SchedulerReferenceIds.push(SchedulerjobResponse?.id)
                await SchedulerReferenceJob?.update({
                  scheduler_ref_ids: SchedulerReferenceIds,
                  activity_id: activity.activity_id,
                })
              }
            }
          } else {
            //add to scheduler reference queue(as we cannot make custom id for repeatable job, we need a reference of schedular jobids)
            if (SchedulerjobResponse?.id !== undefined) {
              await SchedulerReferenceQueue?.add(
                { scheduler_ref_ids: [SchedulerjobResponse?.id], activity_id: activity.activity_id },
                { jobId: activity.activity_id }
              )
            }
          }
        } catch (error) {
          console.log(`"error scheduling custom job-${error}"`)
        }
      }
      count++
    }
  }
}

/**
 *
 * @param scheduler_payload
 * @param activity_id
 */
async function setFortnightlySchedule(scheduler_payload: any, activity_id: string): Promise<any> {
  //fortnightly for first time only
  let start_date = scheduler_payload.start_date
  let SchedulerjobResponse: any
  console.log("fortnightly for first day -- start_date", start_date)
  console.log("fortnightly for first day -- now", new Date())
  if (new Date(start_date) > new Date()) {
    console.log("scheduling fortnightly for first day", start_date)
    try {
      //non repeatable job
      SchedulerjobResponse = await SchedulerQueue?.add(scheduler_payload, {
        removeOnComplete: true,
        removeOnFail: true,
        backoff: 10000,
        attempts: 2,
        jobId: `${activity_id}|fortnightly|${new Date(start_date).getTime()}`,
        delay: Math.floor(new Date(start_date).getTime() - new Date().getTime()),
      })
      console.log("scheduling fortnightly time", Math.floor(new Date(start_date).getTime() - new Date().getTime()))
      const SchedulerReferenceJob = (await SchedulerReferenceQueue?.getJob(activity_id)) || null
      //updating ShedulerReference Queue, if the activity is not saved (make activity.id as job id)
      if (null !== SchedulerReferenceJob) {
        if (!!SchedulerjobResponse.id) {
          const SchedulerReferenceIds: any = SchedulerReferenceJob?.data.scheduler_ref_ids
          const existSchedulerId = await SchedulerReferenceIds.filter((referenceId: any) =>
            referenceId.includes(SchedulerjobResponse?.id)
          )

          if (existSchedulerId.length === 0 && undefined === existSchedulerId[0]) {
            await SchedulerReferenceIds.push(SchedulerjobResponse?.id)
            await SchedulerReferenceJob?.update({
              scheduler_ref_ids: SchedulerReferenceIds,
              activity_id: activity_id,
            })
          }
        }
      } else {
        //add to scheduler reference queue(as we cannot make custom id for repeatable job, we need a reference of schedular jobids)
        if (SchedulerjobResponse?.id !== undefined) {
          await SchedulerReferenceQueue?.add(
            { scheduler_ref_ids: [SchedulerjobResponse?.id], activity_id: activity_id },
            { jobId: activity_id }
          )
        }
      }
      console.log("fortnightly for first day completed")
    } catch (error) {}
  }
}

/**Remove activities from the queue for a given activity_id, if exists
 *
 * @param activity_id
 */
export async function removeActivityJobs(activity_id: string): Promise<any> {
  //fetch all jobs from the SchedulerReference
  const SchedulerReferenceJob = (await SchedulerReferenceQueue?.getJob(activity_id)) || null

  if (null !== SchedulerReferenceJob) {
    const SchedulerReferenceIds: any = SchedulerReferenceJob?.data.scheduler_ref_ids ?? undefined

    for (const shedulerId of SchedulerReferenceIds) {
      try {
        const SchedulerJob = await SchedulerQueue?.getJob(shedulerId)
        await SchedulerJob?.remove()
      } catch (error) {
        console.log(`"Error encountered while removing the jobs-${shedulerId}"`)
      }
    }
    try {
      //remove from sheduler reference job
      await SchedulerReferenceJob?.remove()
      //remove repeatable job object
      await removeRepeatableJob(activity_id)
    } catch (error) {
      console.log(`"Error encountered while ref/repeatable removing the jobs-${error}"`)
    }
  }
}

/**Remove repeatable jobs for given activity_id
 *
 * @param activity_id
 */
async function removeRepeatableJob(activity_id: string): Promise<void> {
  const repeatableJobs = await SchedulerQueue?.getRepeatableJobs()
  const job = (await repeatableJobs?.filter((job) => job.key.includes(activity_id))) as any
  for (let index = 0; index < job.length; index++) {
    await SchedulerQueue?.removeRepeatableByKey(job[index].key)
  }
}

/**Add new device detail to the scheduler while login
 *
 * @param activityIDs
 * @param device_details
 */
export async function updateDeviceDetails(activityIDs: any, device_details: any): Promise<void> {
  //form the device detail to be saved
  const Device =
    device_details.device_token !== undefined
      ? {
          participant_id: device_details.participant_id,
          device_token: device_details.device_token,
          device_type: device_details.device_type.toLowerCase(),
        }
      : undefined
  //Initialise array to store scheduler details to be updated
  const SheduleToUpdate: any = []

  //get the schedulerIds for each activity_id, if present
  for (const activityID of activityIDs) {
    const SchedulerReferenceJobs: any = (await SchedulerReferenceQueue?.getJob(activityID)) || null

    if (null !== SchedulerReferenceJobs) {
      //take sheduler ids to find scheduler job
      for (const shedulerId of SchedulerReferenceJobs.data.scheduler_ref_ids) {
        try {
          //get job details from Sheduler
          const SchedulerJob = (await SchedulerQueue?.getJob(shedulerId)) || null
          if (null !== SchedulerJob) {
            //get the participants for an scheduler id in an array
            const participants: any = SchedulerJob?.data.participants

            if (undefined !== participants) {
              const participantID = await participants.filter((participant: any) =>
                participant.participant_id.includes(device_details.participant_id)
              )

              if (undefined !== participantID) {
                SheduleToUpdate.push({
                  index: participants.indexOf(participantID[0]),
                  shedulerId: shedulerId,
                })
              }
            }
          }
        } catch (error) {
          console.log(`"error updating device in job1-${error}"`)
        }
      }
    } else {
      //only for login
      if (device_details.mode !== 2) {
        await ActivityScheduler(activityID)
      }
    }
  }

  //update device details of a participant
  for (const updateDetail of SheduleToUpdate) {
    try {
      const SchedulerJob = (await SchedulerQueue?.getJob(updateDetail.shedulerId)) || null
      if (null != SchedulerJob) {
        const newParticipants: any = await SchedulerJob?.data.participants

        //remove the participant with old device details
        if (-1 !== updateDetail.index) {
          await newParticipants.splice(updateDetail.index, 1)
        }
        //mode =1-add sensor_event, mode=2-delete sensor_event
        if (device_details.mode === 1) {
          await newParticipants.unshift(Device)
        }

        //Prepare scheduler data
        const data = {
          title: SchedulerJob?.data.title,
          message: SchedulerJob?.data.message,
          activity_id: SchedulerJob?.data.activity_id,
          participants: await removeDuplicateParticipants(newParticipants),
          notificationIds: SchedulerJob?.data.notificationIds ?? undefined,
        }

        //update scheduler with new participant
        await SchedulerJob?.update(data)
      }
    } catch (error) {
      console.log(`"error updating device in job2-${error}"`)
    }
  }
}

/**remove duplicate participants from participants array in a job queue
 *
 * @param participants
 * @returns
 */
export async function removeDuplicateParticipants(participants: any): Promise<any> {
  const uniqueParticipants = []
  const map = new Map()
  for (const item of participants) {
    if (!map.has(item.device_token)) {
      map.set(item.device_token, true)
      uniqueParticipants.push({
        device_type: item.device_type,
        device_token: item.device_token,
        participant_id: item.participant_id,
      })
    }
  }
  return uniqueParticipants
}

/**clean all jobs
 *
 */
export async function cleanAllQueues(): Promise<any> {
  // console.log("CLEANING ALL QUEUE")
  await SchedulerQueue?.clean(0, "delayed")
  await SchedulerQueue?.clean(0, "wait")
  await SchedulerQueue?.clean(0, "active")
  await SchedulerQueue?.clean(0, "completed")
  await SchedulerQueue?.clean(0, "failed")
  if (!!SchedulerQueue) {
    let multi_1 = SchedulerQueue.multi()
    await multi_1.del(SchedulerQueue.toKey("repeat"))
    await multi_1.exec()
    await SchedulerQueue.empty()
  }

  await SchedulerReferenceQueue?.clean(0, "delayed")
  await SchedulerReferenceQueue?.clean(0, "wait")
  await SchedulerReferenceQueue?.clean(0, "active")
  await SchedulerReferenceQueue?.clean(0, "completed")
  await SchedulerReferenceQueue?.clean(0, "failed")
  if (!!SchedulerReferenceQueue) {
    let multi_2 = SchedulerReferenceQueue.multi()
    await multi_2.exec()
    await SchedulerReferenceQueue.empty()
  }
  console.log("DONE--CLEANING ALL QUEUE")
}

/**check for the presence of activity in the  topic published to get scheduled
 *
 * @param token
 * @param data
 */
export const UpdateSchedule = (topic: string, data: any) => {
  if (topic === "activity") {
    const data_ = JSON.parse(data) ?? undefined
    if (!!data_ && data_.action !== "delete") {
      //update activity schedule in cache for add/update/delete of an activity
      UpdateToSchedulerQueue?.add(
        { activity_id: data_.activity_id },
        {
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: 10000,
        }
      )
    } else {
      //delete activity schedule in cache for delete of an activity
      DeleteFromSchedulerQueue?.add(
        { activity_id: data.activity_id },
        {
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: 10000,
        }
      )
    }
  } else if (topic === "sensor_event") {
    const sensor = JSON.parse(data).sensor ?? undefined
    const data_ = JSON.parse(data).data ?? undefined
    const participant_id = JSON.parse(data).participant_id ?? undefined
    console.log("participant_id listened", participant_id)
    if (!!sensor && (sensor === "lamp.analytics" || sensor === "analytics") && undefined !== data_.device_token) {
      SchedulerDeviceUpdateQueue?.add(
        {
          device_type: data_.device_type,
          device_token: data_.device_token,
          participant_id: participant_id,
          mode: 1,
        },
        { attempts: 3, backoff: 10000, removeOnComplete: true, removeOnFail: true }
      )
    }
    //update activity schedule in cache for login/logout of an participant
    if ((sensor === "lamp.analytics" || sensor === "analytics") && data_.action === "logout") {
      SchedulerDeviceUpdateQueue?.add(
        { device_type: undefined, device_token: undefined, participant_id: participant_id, mode: 2 },
        { attempts: 3, backoff: 10000, removeOnComplete: true, removeOnFail: true }
      )
    }
  }
}
